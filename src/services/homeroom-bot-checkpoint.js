'use strict';

// ── Where a bot build is between its steps ──────────────────────────────
//
// A Homeroom bot build's agent turns survive a restart (they run detached in
// their worker, with a journal), but its position BETWEEN turns lived only in
// the leader's memory: a restart after the build turn pushed and before the
// proposal rebuilt the pushed work from its plan, and one before the spec
// turn sent the request back to be triaged. So each step boundary of a live
// or shadow build (homeroom-bot-live.js buildAndPropose's `onStep`) is saved
// on its run, in homeroom_bot_runs.build_checkpoint:
//
//   { sessionId, step, at, ...what the step left, once: { debited } }
//
//   step 'session'     the session is linked to the run; nothing spent yet
//        'spec_turn'   the spec turn is about to be dispatched
//        'spec'        the plan is written and published (specVersion)
//        'build_turn'  the build turn is about to be dispatched
//        'landed'      the build turn (and any nudge) pushed: landed { sha,
//                      commits, pushOk, text, partial }
//        'reviewed'    a first version's review is over: reviewed { finalSha,
//                      finalCommits, costUsd } (its rounds are saved on the
//                      run's `review` as they go)
//        'proposed'    the proposal is open: prNumber
//
// A checkpoint belongs to one session: a run that starts a new session (a
// build resumed from its plan, a first version's retry) starts a new one,
// keeping only `once`. `recovered` is what restart recovery found for the
// session's last turn (homeroom-bot.js noteRecoveredLive), kept here so a
// second restart before recovery acts on it does not lose it.
//
// Restart recovery (homeroom-bot.js completeRecoveredLive, and the sweep
// resumeStalledLiveBuilds) reads it to carry the build on from its step. The
// workflow-engine plan (docs/plans/bot-build-workflow.md, #4888) replaces
// all of this with the kernel's saved states; it is kept in this file and a
// few calls so it can be deleted whole.

const log = require('./logger');

const STEPS = ['session', 'spec_turn', 'spec', 'build_turn', 'landed', 'reviewed', 'proposed'];

// Past these steps the build pushed work a restart must not build again.
const LANDED_STEPS = new Set(['landed', 'reviewed', 'proposed']);
// Before this one nothing was spent on a model: a restart starts it again.
const BEFORE_SPEND_STEPS = new Set(['session']);

// What a recovered turn's result keeps when it is saved: the fields the
// recovery reads, never the raw stream. Long text is clipped.
const MAX_TEXT_CHARS = 20000;

function stepIndex(step) {
  return STEPS.indexOf(step);
}

/** The result fields worth keeping, JSON-safe and bounded. Pure. */
function slimResult(result) {
  if (!result || typeof result !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === 'rawStdout' || key === 'rawStderr' || value == null) continue;
    if (typeof value === 'string') out[key] = value.length > MAX_TEXT_CHARS ? value.slice(0, MAX_TEXT_CHARS) : value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (key === 'answerParts' && Array.isArray(value)) {
      out[key] = value.filter((p) => typeof p === 'string').map((p) => p.slice(0, MAX_TEXT_CHARS));
    }
  }
  return out;
}

/**
 * Save the step a build reached. Merged into the run's checkpoint for the
 * same session; a different session starts it afresh (keeping `once`). Only
 * on a run with no outcome yet. Never throws: a checkpoint that could not be
 * written leaves recovery where it was before checkpoints.
 */
async function save(pool, runId, sessionId, step, data = {}) {
  if (!runId || !sessionId || stepIndex(step) < 0) return false;
  const patch = { ...data, sessionId: Number(sessionId), step, at: new Date().toISOString() };
  try {
    const { rowCount } = await pool.query(
      `UPDATE homeroom_bot_runs
          SET build_checkpoint = (CASE
                WHEN (build_checkpoint->>'sessionId')::int IS NOT DISTINCT FROM $2::int THEN build_checkpoint
                ELSE jsonb_build_object('once', COALESCE(build_checkpoint->'once', '{}'::jsonb))
              END) || $3::jsonb
        WHERE id = $1 AND build_ok IS NULL`,
      [Number(runId), Number(sessionId), JSON.stringify(patch)],
    );
    return rowCount > 0;
  } catch (err) {
    log.warn('homeroom-bot', 'Could not save a build\'s checkpoint', { runId, sessionId, step, err: err.message });
    return false;
  }
}

/** A run's checkpoint, or null. `sessionId` given: only that session's. Never throws. */
async function read(pool, runId, sessionId = null) {
  try {
    const { rows: [r] = [] } = await pool.query(
      'SELECT build_checkpoint FROM homeroom_bot_runs WHERE id = $1', [Number(runId)],
    );
    const cp = r?.build_checkpoint && typeof r.build_checkpoint === 'object' ? r.build_checkpoint : null;
    if (!cp) return null;
    if (sessionId != null && Number(cp.sessionId) !== Number(sessionId)) return null;
    return cp;
  } catch {
    return null;
  }
}

/**
 * Keep what restart recovery found for a session's turn (the note
 * completeRecoveredLive acts on). Never throws.
 */
async function noteRecovered(pool, runId, sessionId, outcome = {}) {
  const note = {
    mode: outcome.mode || null,
    result: slimResult(outcome.result),
    timedOut: !!outcome.timedOut,
    component: outcome.component || null,
    harness: outcome.harness || null,
    deadlineMs: Number.isFinite(Number(outcome.deadlineMs)) && outcome.deadlineMs != null ? Number(outcome.deadlineMs) : null,
    lost: !!outcome.lost,
    why: outcome.why || null,
  };
  try {
    await pool.query(
      `UPDATE homeroom_bot_runs
          SET build_checkpoint = (CASE
                WHEN (build_checkpoint->>'sessionId')::int IS NOT DISTINCT FROM $2::int THEN build_checkpoint
                ELSE jsonb_build_object('once', COALESCE(build_checkpoint->'once', '{}'::jsonb), 'sessionId', $2::int)
              END) || jsonb_build_object('recovered', $3::jsonb, 'at', NOW())
        WHERE id = $1 AND build_ok IS NULL`,
      [Number(runId), Number(sessionId), JSON.stringify(note)],
    );
  } catch (err) {
    log.warn('homeroom-bot', 'Could not keep what recovery found for a build', { runId, sessionId, err: err.message });
  }
  return note;
}

/**
 * Drop what recovery found for a session's last turn, once recovery starts
 * a new turn in it (a review's fix turns): a later restart must not read the
 * old turn's result as the new one's. Never throws.
 */
async function clearRecovered(pool, runId, sessionId) {
  try {
    await pool.query(
      `UPDATE homeroom_bot_runs SET build_checkpoint = build_checkpoint - 'recovered'
        WHERE id = $1 AND (build_checkpoint->>'sessionId')::int = $2::int`,
      [Number(runId), Number(sessionId)],
    );
  } catch { /* the note only ever helps */ }
}

/**
 * What a checkpoint says the build had already done, as recovery decides on
 * it: `landed` (with the result to propose from) once the build pushed,
 * `reviewed` once its review is over, `prNumber` once proposed, and
 * `beforeSpend` while nothing had been spent on a model. Pure.
 */
function position(cp) {
  if (!cp || stepIndex(cp.step) < 0) return { step: null };
  const out = { step: cp.step, specVersion: cp.specVersion ?? null };
  if (BEFORE_SPEND_STEPS.has(cp.step)) out.beforeSpend = true;
  if (LANDED_STEPS.has(cp.step) && cp.landed && cp.landed.sha) {
    const reviewed = cp.reviewed && cp.reviewed.finalSha ? cp.reviewed : null;
    out.landed = {
      pushOk: true,
      sha: (reviewed && reviewed.finalSha) || cp.landed.sha,
      ahead: Number((reviewed && reviewed.finalCommits) || cp.landed.commits) || 1,
      lastResultText: cp.landed.text || '',
    };
    if (reviewed) out.reviewed = reviewed;
    if (cp.prNumber) out.prNumber = Number(cp.prNumber);
  }
  return out;
}

/**
 * Debit a session's cost from the bot's allowance once, whichever path (the
 * live build or restart recovery, any number of times) gets there: the run
 * keeps how much of each session it debited, and only what is beyond that
 * is debited now. `debit(usd)` does the debit. A run that cannot be read
 * (no row) debits the whole amount, as before. Resolves what was debited.
 */
async function debitOnce(pool, { runId, sessionId, totalUsd, debit }) {
  const total = Number(totalUsd);
  if (!(total > 0)) return 0;
  if (!runId || !sessionId) { await debit(total); return total; }
  let before = null;
  try {
    const { rows: [r] = [] } = await pool.query(
      `WITH cur AS (
         SELECT id, COALESCE((build_checkpoint #>> ARRAY['once', 'debited', $2::text])::numeric, 0) AS done
           FROM homeroom_bot_runs WHERE id = $1 FOR UPDATE
       )
       UPDATE homeroom_bot_runs r
          SET build_checkpoint = COALESCE(r.build_checkpoint, '{}'::jsonb) || jsonb_build_object('once',
                COALESCE(r.build_checkpoint->'once', '{}'::jsonb) || jsonb_build_object('debited',
                  COALESCE(r.build_checkpoint #> '{once,debited}', '{}'::jsonb)
                    || jsonb_build_object($2::text, GREATEST(cur.done, $3::numeric))))
         FROM cur
        WHERE r.id = cur.id
        RETURNING cur.done::float8 AS done`,
      [Number(runId), String(Number(sessionId)), total],
    );
    if (r && Number.isFinite(Number(r.done))) before = Number(r.done);
  } catch (err) {
    log.warn('homeroom-bot', 'Could not read what a build already debited; debiting it whole', { runId, sessionId, err: err.message });
  }
  const due = before == null ? total : Math.round((total - before) * 1e8) / 1e8;
  if (!(due > 0)) return 0;
  await debit(due);
  return due;
}

/**
 * The proposal a build session already is, when a restart came after the
 * promote route opened it and before the build recorded it: { prNumber }
 * once the session is up for a vote (or past it), else null. Never throws.
 */
async function adoptedProposal(pool, sessionId) {
  try {
    const { rows: [s] = [] } = await pool.query(
      `SELECT status, pr_number FROM chat_sessions
        WHERE id = $1 AND status IN ('promoted', 'merging', 'merged') AND pr_number IS NOT NULL`,
      [Number(sessionId)],
    );
    return s ? { prNumber: Number(s.pr_number) } : null;
  } catch {
    return null;
  }
}

/** Whether the run already said this kind of post (homeroom_bot_posts, written before the post). Never throws. */
async function runPosted(pool, runId, kind) {
  if (!runId) return false;
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM homeroom_bot_posts WHERE run_id = $1 AND kind = $2 LIMIT 1', [Number(runId), String(kind)],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

module.exports = {
  STEPS,
  slimResult,
  save,
  read,
  noteRecovered,
  clearRecovered,
  position,
  debitOnce,
  adoptedProposal,
  runPosted,
};
