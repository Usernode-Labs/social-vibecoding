'use strict';

// The agent has already finished. Only publication is retried here: its
// journal and active_turn remain the recovery source until this receipt is
// complete. A failed receipt keeps the saved commit for startup/eviction rescue.
const { createHash } = require('node:crypto');
const { withSessionLock } = require('../db/session-locks');
const { WORKER_EVICTION_LOCK } = require('./advisory-locks');
const lifecycle = require('./turn-lifecycle');
const effects = require('./turn-effects');
const savedWork = require('./worker-unpushed-commit');

const EFFECT = 'git_publication';
const RETRY_MS = [1000, 2000, 5000, 10000];

// Old records can lack a UUID. Their unique journal still names one physical
// attempt; use a deterministic UUID in the existing receipt table.
function receiptId(turn) {
  const id = turn.turnUuid || turn.turnId;
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id || '')) return id;
  const h = createHash('sha256').update(String(turn.journal)).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Called before dispatch, also for a pre-registered OpenRouter attempt.
// Capture the destination from platform state, never the worker's remote.
async function captureTarget(pool, sessionId, turnId, branchName, journal = null) {
  const { rows: [row] } = await pool.query(
    `UPDATE chat_sessions cs SET active_turn = cs.active_turn || jsonb_build_object('publicationTarget',
       jsonb_build_object('appId', cs.app_id, 'userId', cs.user_id, 'repoUrl', a.repo_url, 'branchName', cs.branch_name))
     FROM apps a, users u WHERE cs.id = $1 AND a.id = cs.app_id AND u.id = cs.user_id
       AND (cs.active_turn->>'turnId' = $2 OR ($2::text IS NULL AND cs.active_turn->>'journal' = $4))
       AND ($4::text IS NULL OR cs.active_turn->>'journal' = $4)
       AND cs.branch_name = $3
       AND cs.status IN ('active', 'promoted') AND u.anonymised_at IS NULL
     RETURNING cs.active_turn->'publicationTarget' AS target`, [sessionId, turnId, branchName, journal]);
  if (!row?.target?.repoUrl) throw Object.assign(new Error('The session publication target is unavailable or changed.'), { code: 'session_changed' });
  return row.target;
}

function eligible(mode, result) {
  return (mode === 'build' || mode === 'sync') && result?.resultSeen === true
    && (mode === 'sync' || result.ahead > 0) && !!result.sha && !result.branchMismatch
    && (mode !== 'sync' || ['clean', 'resolved'].includes(result.syncResult));
}

function apply(result, outcome) {
  return { ...result, pushOk: outcome.ok === true,
    ...(outcome.ok ? { sha: outcome.sha } : { pushFailed: outcome.code, pushFailure: outcome }) };
}

async function publish({ pool, sessionId, turnId, journal, mode, branchName, result, push,
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  if (!eligible(mode, result)) return result;
  const role = require('./process-role');
  if (!role.runsWorkflow(role.processRole())) throw new Error('Turn publication requires a conductor');
  let lost = false;
  try {
    for (;;) {
      const out = await withSessionLock(pool, [WORKER_EVICTION_LOCK, sessionId], async () => {
        const turn = await lifecycle.loadActiveTurn(pool, sessionId);
        if (!turn || (turnId ? turn.turnId !== turnId : turn.journal !== journal) || turn.journal !== journal) {
          throw Object.assign(new Error('The publication no longer owns this turn.'), { code: 'stale_turn_owner' });
        }
        const id = receiptId(turn);
        // Only pre-protocol records need this fallback; new dispatches captured
        // their exact app/repository/owner/branch before running the agent.
        const target = turn.publicationTarget || await captureTarget(pool, sessionId, turn.turnId || null, branchName, journal);
        const claim = await effects.claimExternalEffect({ pool, turnId: id, effectKey: EFFECT, sessionId,
          intent: { target, sha: result.sha, attempts: 0 } });
        if (claim.state === 'completed') {
          if (claim.result.ok) await savedWork.clear(pool, sessionId, claim.result.sha, claim.result.target.branchName);
          return { result: apply(result, claim.result) };
        }
        if (claim.state !== 'pending') throw new Error('Invalid publication receipt');
        const intent = claim.result;
        // Persist before I/O or releasing the lock. No reset or eviction may
        // silently replace a finished turn's only copy of its commit.
        if (!(await savedWork.record(pool, sessionId, { sha: intent.sha, branchName: intent.target.branchName }, turn.turnId))) {
          throw Object.assign(new Error('The saved commit no longer owns this turn.'), { code: 'stale_turn_owner' });
        }
        const finish = async outcome => {
          await effects.completeExternalEffect({ pool, turnId: id, effectKey: EFFECT,
            result: { ...outcome, sha: outcome.sha || intent.sha, target: intent.target } });
          const receipt = await effects.claimExternalEffect({ pool, turnId: id, effectKey: EFFECT, sessionId });
          if (receipt.result.ok) await savedWork.clear(pool, sessionId, intent.sha, intent.target.branchName);
          return { result: apply(result, receipt.result) };
        };
        if (intent.sha !== result.sha || ['appId', 'userId', 'repoUrl', 'branchName'].some(k => intent.target[k] !== target[k])) {
          return finish({ ok: false, code: 'session_changed', permanent: true, message: 'The publication target or commit changed.' });
        }
        if (lifecycle.stopRequestOf(turn)) {
          return finish({ ok: false, code: 'turn_stopped', permanent: true, message: 'The turn was stopped before publication.' });
        }
        if (intent.retryAt > now()) return { wait: intent.retryAt - now() };
        if (lost) throw new Error('Turn publication lost its lock');
        const attempts = Number(intent.attempts || 0) + 1;
        // Commit the attempt before the external call. A restart with an
        // uncertain push safely repeats this exact non-forcing publication.
        await pool.query(`UPDATE turn_effects SET result = $3::jsonb, updated_at = NOW()
          WHERE turn_id = $1 AND effect_key = $2 AND state = 'pending'`,
        [id, EFFECT, JSON.stringify({ ...intent, attempts, retryAt: null })]);
        let outcome;
        try {
          const pushed = await push(intent.target.branchName, {
            expectedAppId: intent.target.appId, expectedRepoUrl: intent.target.repoUrl,
            expectedUserId: intent.target.userId, expectedSha: intent.sha,
          });
          if (pushed.sha !== intent.sha) throw Object.assign(new Error('The published commit changed.'), { code: 'commit_changed', permanent: true });
          outcome = { ok: true, sha: pushed.sha };
        } catch (err) {
          outcome = { ok: false, code: err.code || 'push_failed', permanent: err.permanent === true,
            message: String(err.message || 'Publication failed').slice(0, 2000), userMessage: err.userMessage || null };
        }
        if (lost) throw new Error('Turn publication lost its lock');
        if (outcome.ok || outcome.permanent || attempts > RETRY_MS.length) return finish(outcome);
        const wait = RETRY_MS[attempts - 1];
        await pool.query(`UPDATE turn_effects SET result = $3::jsonb, updated_at = NOW()
          WHERE turn_id = $1 AND effect_key = $2 AND state = 'pending'`,
        [id, EFFECT, JSON.stringify({ ...intent, attempts, retryAt: now() + wait, lastFailure: outcome })]);
        return { wait };
      }, { onLost: () => { lost = true; } });
      if (out.result) return out.result;
      // The eviction lock is released while backing off, so Stop can stamp
      // this turn. The saved commit and active record continue to protect it.
      await sleep(out.wait);
    }
  } catch (err) {
    err.retainActiveTurn = true;
    err.retryWorkerRecovery = true;
    throw err;
  }
}

// Normal cleanup cannot outrun pending publication. Explicit Stop may end it,
// but first records that decision and keeps the saved commit for rescue.
async function beforeCleanup(pool, sessionId, turn) {
  if (!turn?.publicationTarget) return;
  const id = receiptId(turn);
  const { rows: [receipt] } = await pool.query(
    'SELECT state, result FROM turn_effects WHERE turn_id = $1 AND effect_key = $2', [id, EFFECT]);
  if (receipt?.state !== 'pending') return;
  if (!lifecycle.stopRequestOf(turn)) {
    throw Object.assign(new Error('Turn publication is still pending.'), { code: 'publication_pending', retainActiveTurn: true });
  }
  await effects.completeExternalEffect({ pool, turnId: id, effectKey: EFFECT, result: {
    ok: false, code: 'turn_stopped', permanent: true, message: 'The turn was stopped before publication.',
    sha: receipt.result.sha, target: receipt.result.target,
  } });
}

module.exports = { publish, captureTarget, beforeCleanup, eligible, receiptId, EFFECT };
