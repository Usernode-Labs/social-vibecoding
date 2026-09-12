'use strict';

// #2038 — the integration queue.
//
// One proposal per app is brought onto current main, checked against the
// merged tree, and merged. Everything else is left alone and simply measured.
//
// ── What this replaces ─────────────────────────────────────────────────
//
// services/conflict-resolver.js ran a two-phase drain: phase 1 merged
// anything directly mergeable, phase 2 ran worker syncs for the rest. The
// split existed because a blocked proposal's minutes-long sync ran INSIDE the
// single-flight drain and froze every clean sibling behind it. A queue where
// a blocked proposal leaves the queue does not have that failure, so the
// phases are gone.
//
// Two behaviours change, and both were bugs:
//
//   - The drain's candidate filter was the merge gate, so only proposals
//     already eligible to merge were ever touched. A proposal that drifted
//     before reaching threshold was synced by nobody, measured by nobody and
//     reconciled by nobody, while its card read "Behind main · N — syncing
//     automatically" (#2038 F2). MEASUREMENT is now separate and universal
//     (services/integration.js, driven by the sweep); only INTEGRATION —
//     which costs a worker turn and real tokens — is gated on eligibility,
//     and the card says so honestly instead of promising a sync.
//
//   - Checks in flight were QUEUED behind, not superseded. #1728 recorded
//     the cost: two syncs, two abandoned runs (one of them 490 checks in),
//     two ten-minute dead waits and three full runs for one proposal. The
//     supersede primitive already existed in services/preview-lifecycle.js;
//     it simply was not used here.
//
// ── What is NOT here any more ──────────────────────────────────────────
//
// pollMergeable and waitForMergeableTrue — up to fourteen GitHub reads and
// ~30 seconds of sleeping per cycle, spent asking a lazily-computed field
// whether a branch merges. The mirror answers that exactly, before the call.
// The exact-sha merge is still the real guard: if main moves between the
// measurement and the merge, GitHub refuses with a 409 and the queue comes
// back round. That was always the only guarantee; the polling just made the
// window narrower at considerable cost.

const log = require('./logger');
const github = require('./github');
const limits = require('./limits');
const integration = require('./integration');
const { runSyncMain } = require('./sync-main');
const { currentVotePredicateSql } = require('./pr-vote-revision');
const { getPool } = require('../db/pool');

// App-level single-flight. Every trigger — a vote crossing threshold, a
// post-merge cascade, the drift poller, the eligible-merge sweep — funnels
// here, so concurrent triggers for one app coalesce into one sequential pass
// instead of N parallel worker syncs against the same main.
const _running = new Map(); // appId -> Promise
const _rekick = new Set();  // appId -> a trigger arrived mid-pass

/** True while this app is integrating something. Read by the status routes. */
function isIntegrating(appId) {
  return _running.has(appId);
}

/**
 * Ask the app's queue to make progress. Safe to call from anywhere, as often
 * as you like: a call while a pass is running flags a re-kick rather than
 * starting a second one.
 */
function enqueue(config, appId, options = {}) {
  if (appId == null) return Promise.resolve();
  if (_running.has(appId)) {
    _rekick.add(appId);
    return _running.get(appId);
  }
  const run = runQueue(config, appId, options)
    .catch((err) => log.error('merge-queue', 'queue pass threw', { appId, err: err.message }))
    .finally(() => {
      _running.delete(appId);
      if (_rekick.delete(appId)) {
        enqueue(config, appId).catch((err) => log.error('merge-queue', 're-kick failed', {
          appId, err: err.message,
        }));
      }
    });
  _running.set(appId, run);
  return run;
}

// The next proposal worth spending a worker turn on: promoted, eligible on
// votes, and not the one we just merged. Ordered by the vote tally so the
// group's strongest preference goes first, then longest-waiting.
async function nextCandidate(pool, appId, { excludeId = 0, attempted = [] }) {
  const governance = require('./governance');
  const gov = await governance.getGovernance(pool, appId);
  const electorate = await governance.getElectorate(pool, appId, gov);

  const { rows } = await pool.query(
    `SELECT cs.id, cs.promoted_at, cs.created_at, cs.requires_explicit_approval,
            cs.integration_behind_by, cs.integration_merges_clean, cs.check_state,
            (SELECT COUNT(*)::int FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'yes'
                AND ${currentVotePredicateSql('pv', 'cs')}) AS yes_count,
            (SELECT COUNT(*)::int FROM pr_votes pv
              WHERE pv.session_id = cs.id AND pv.vote = 'no'
                AND ${currentVotePredicateSql('pv', 'cs')}) AS no_count
       FROM chat_sessions cs
      WHERE cs.app_id = $1 AND cs.status = 'promoted' AND cs.id <> $2
        AND NOT (cs.id = ANY($3::int[]))`,
    [appId, excludeId, attempted]
  );

  const qualified = electorate.approverIds
    ? await governance.qualifiedCountsBatch(pool, 'pr', rows.map((r) => r.id), electorate.approverIds)
    : null;

  const eligible = rows.filter((r) => {
    const q = qualified ? (qualified.get(r.id) || { yes: 0, no: 0 })
      : { yes: r.yes_count, no: r.no_count };
    return governance.computeGate(
      gov, electorate.active, q.yes, q.no, r.promoted_at || r.created_at, null,
      { explicitApproval: !!r.requires_explicit_approval }
    ).mergeable;
  });

  const toMs = (v) => (v instanceof Date ? v.getTime()
    : typeof v === 'number' ? v : (Date.parse(v) || 0));

  eligible.sort((a, b) => (b.yes_count - a.yes_count)
    || (toMs(a.promoted_at || a.created_at) - toMs(b.promoted_at || b.created_at)));

  return eligible[0] || null;
}

async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url, a.name AS app_name,
            a.self_hosted AS app_self_hosted
       FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
      WHERE cs.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

async function runQueue(config, appId, { excludeSessionId = 0 } = {}) {
  const pool = getPool(config);
  const attempted = [];
  const seen = new Set();

  // Termination is belt AND braces. The candidate query excludes what has
  // already been attempted, but this loop runs unattended in a background
  // service: if that exclusion ever stopped working — a query edit, a
  // parameter-type surprise — the pass would spin forever dispatching worker
  // turns. So the JS side refuses a repeat too, and an absolute cap bounds
  // the pass no matter what. An app cannot have more eligible proposals than
  // it has proposals.
  const MAX_PASSES = 50;
  for (let i = 0; i < MAX_PASSES; i++) {
    _rekick.delete(appId);
    const candidate = await nextCandidate(pool, appId, {
      excludeId: excludeSessionId, attempted,
    });
    if (!candidate) {
      if (_rekick.has(appId)) continue;
      return;
    }
    if (seen.has(candidate.id)) {
      log.warn('merge-queue', 'candidate query returned an already-attempted proposal; stopping', {
        appId, sessionId: candidate.id,
      });
      return;
    }
    seen.add(candidate.id);
    attempted.push(candidate.id);
    try {
      await integrateOne(config, pool, candidate.id);
    } catch (err) {
      log.error('merge-queue', 'integrateOne threw', { sessionId: candidate.id, err: err.message });
    }
  }
  log.warn('merge-queue', 'queue pass hit its iteration cap', { appId, attempted: attempted.length });
}

// Per-session coalescing: a vote and a sweep can name the same proposal at
// once, and two concurrent syncs for one session hit the worker's
// "a turn is already in flight" guard.
const _inFlight = new Map();

function integrateOne(config, pool, sessionId) {
  const existing = _inFlight.get(sessionId);
  if (existing) return existing;
  const p = integrateOneInner(config, pool, sessionId)
    .finally(() => { _inFlight.delete(sessionId); });
  _inFlight.set(sessionId, p);
  return p;
}

/** True while this proposal is being integrated. Read by the status routes. */
function isIntegratingSession(sessionId) {
  return _inFlight.has(sessionId);
}

async function integrateOneInner(config, pool, sessionId) {
  const session = await loadSession(pool, sessionId);
  if (!session || session.status !== 'promoted') return { ok: false, reason: 'not_promoted' };
  if (!github.isEnabled() || !session.repo_url || !session.pr_number) {
    return { ok: false, reason: 'github_disabled_or_no_pr' };
  }

  const { checkAndMerge } = require('../routes/votes');

  // Measure first, from the mirror. No GitHub call, no polling window, and
  // the answer is exact rather than a field GitHub may still be computing.
  const measured = await integration.measureDeduped({ pool, session }, { force: true });

  const needsIntegration = (measured.behindBy || 0) > 0 || measured.mergesClean === false;
  if (!needsIntegration) {
    // Already on main and clean: the only thing between it and a merge is
    // the rest of the gate, so go straight there.
    return runMerge(config, pool, session, checkAndMerge);
  }

  // A worker sync is platform housekeeping, billed to the system budget
  // rather than to whoever voted last.
  const budget = await limits.checkSystemBudget(pool);
  if (budget.error) {
    await integration.setBlockReasons(pool, session.id, ['budget']);
    log.info('merge-queue', 'Skipped: system token budget exhausted', { sessionId });
    return { ok: false, reason: 'over_budget' };
  }

  await integration.setBlockReasons(pool, session.id, ['integrating']);
  broadcast(session, { integrating: true });

  // #1728: supersede any check run in flight before moving the branch under
  // it. The run that is going tested the PRE-merge commit, and its verdict
  // is keyed to the commit it started on, so letting it finish writes a
  // verdict nowhere and leaves the row 'pending' until the stale sweeper
  // notices ten minutes later.
  try {
    const previewLifecycle = require('./preview-lifecycle');
    if (typeof previewLifecycle.cancelled === 'function') {
      previewLifecycle.cancelled(session.id, 'superseded by integration');
    }
  } catch (err) {
    log.debug('merge-queue', 'no in-flight check run to supersede', { sessionId, err: err.message });
  }

  let sync;
  try {
    sync = await runSyncMain(config, pool, session.id, {
      sessionRow: session, trigger: 'merge_queue',
    });
  } catch (err) {
    log.error('merge-queue', 'sync turn threw', { sessionId, err: err.message });
    await integration.setBlockReasons(pool, session.id, []);
    broadcast(session, { integrating: false });
    return { ok: false, reason: 'sync_threw' };
  }

  if (sync.syncResult === 'conflict') {
    // The worker could not resolve it. This proposal leaves the queue: it
    // needs a person, and holding the app's queue open for it would block
    // every sibling behind something only its author can fix.
    const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
    await postGroup(pool, session,
      `PR #${session.pr_number} could not be brought up to date with main automatically. `
      + `${owner}: open the session's dev-chat to resolve it.`);
    // The queue is done with it; the card derives the conflict itself from
    // merge_conflict_state, which the sync turn just wrote.
    await integration.setBlockReasons(pool, session.id, []);
    broadcast(session, { integrating: false });
    return { ok: false, reason: 'unresolved_conflict' };
  }

  // Re-read: the sync moved the head, and the reconciliation inside
  // checkAndMerge needs the current row.
  const fresh = await loadSession(pool, session.id);
  if (!fresh || fresh.status !== 'promoted') {
    broadcast(session, { integrating: false });
    return { ok: true, reason: 'no_longer_promoted' };
  }
  await integration.measureDeduped({ pool, session: fresh }, { force: true }).catch(() => {});
  broadcast(fresh, { integrating: false });

  return runMerge(config, pool, fresh, checkAndMerge);
}

async function runMerge(config, pool, session, checkAndMerge) {
  let result;
  try {
    // autoResolve:false so a merge that fails here cannot re-enter the queue
    // from inside the queue. One integrate-and-merge cycle per pass.
    result = await checkAndMerge(config, pool, session, { autoResolve: false });
  } catch (err) {
    log.error('merge-queue', 'checkAndMerge threw', { sessionId: session.id, err: err.message });
    return { ok: false, reason: 'merge_threw' };
  }
  if (result?.merged) {
    try {
      const { pushVoteUpdate } = require('./ws');
      pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
    } catch (_) { /* ws non-fatal */ }
    return { ok: true, reason: 'merged' };
  }
  // Not merged. The block reason is already recorded on the integration
  // record by the gate that refused, so there is nothing to announce here —
  // the old code posted a vote tally at this point even when the blocker was
  // the checks, which is #2038's F5.
  return { ok: true, reason: result?.blockReason || 'blocked' };
}

function broadcast(session, extra) {
  try {
    const { pushVoteUpdate } = require('./ws');
    pushVoteUpdate({
      sessionId: session.id,
      appSlug: session.app_slug || null,
      merged: false,
      ...extra,
    });
  } catch (_) { /* ws non-fatal */ }
}

async function postGroup(pool, session, content) {
  try {
    const { sendSystemMessage } = require('./ws');
    await sendSystemMessage(pool, session.app_id, content, 'conflict');
  } catch (err) {
    log.warn('merge-queue', 'group message failed', { sessionId: session?.id, err: err.message });
  }
}

module.exports = {
  enqueue,
  isIntegrating,
  isIntegratingSession,
  // The old name, so the dozen callers across server.js, visuals.js,
  // votes.js and main-drift-poller.js keep working. `trigger.app_id` and
  // `trigger.excludeSessionId` are the only fields any of them set.
  checkAndResolveConflicts(config, trigger) {
    return enqueue(config, trigger && trigger.app_id, {
      excludeSessionId: trigger && (trigger.excludeSessionId != null
        ? trigger.excludeSessionId : (trigger.id || 0)),
    });
  },
};
