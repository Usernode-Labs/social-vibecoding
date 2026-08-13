'use strict';

// Shared session lifecycle transitions, callable from both HTTP route
// handlers (manual pause/resume) and the background sweeper (auto-pause).
//
// Why a service instead of inline route logic: the auto-pause sweeper in
// server.js needs to run the exact same teardown the manual POST /pause
// endpoint does (status flip + staging teardown + worker destroy + WS
// notify), and we don't want two copies drifting apart. Resume's LRU
// logic in routes/sessions.js also leans on pauseSession here.

const log = require('./logger');
const staging = require('./staging');
const worker = require('./worker');
const { isSessionBusy } = require('./active-workers');
const workerProgress = require('./worker-progress');
const github = require('./github');

// Parse "owner/repo" out of a stored GitHub repo URL. Returns [owner,
// repo] or [] when the URL is missing/unparseable.
function ownerRepo(repoUrl) {
  const [, owner, repo] = (repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? [owner, repo] : [];
}

// Transition a session 'active'|'promoted' -> 'paused'. Reversible: keeps
// the CC volume, branch, PR, AND the staging preview so /resume restores
// cleanly (and cheaply — no staging rebuild). Mirrors the historical
// POST /pause handler body, minus the HTTP-only concerns (auth scoping,
// already-paused soft-200, the in-flight activeWorkers set that lives in
// routes/sessions.js).
//
// NOTE: pause deliberately no longer tears down staging. Staging has its
// own lifecycle now (kept alive across pause so reopening is cheap;
// reclaimed by teardownStagingForSession on a longer idle timer, or on
// archive/merge). Worker re-warm is cheap (~5-30s); a staging rebuild is
// not (docker build + pg clone), so pausing on a short idle timer must
// not pay that cost.
//
// Callers that pause a session which might have a CC turn in flight (the
// manual endpoint, where the user may pause to abort) handle the
// activeWorkers bookkeeping themselves before calling this. The sweeper
// only ever calls this for sessions that are NOT in flight, so there's
// nothing to clear there.
//
// Params:
//   pool      - pg pool
//   sessionId - numeric session id
//   userId    - optional; when set, scopes the status flip to that owner
//               (authz for the manual endpoint). Omit for system actions.
//   reason    - free-form string for logs ('manual' | 'auto-idle' | 'lru')
//
// Returns { paused: boolean, appSlug?: string }. paused=false means the
// row wasn't in a pausable state (already paused/archived/merged, or not
// owned by userId) and nothing was torn down.
async function pauseSession({ pool, sessionId, userId = null, reason = 'manual' }) {
  const params = [sessionId];
  let ownerClause = '';
  if (userId != null) {
    params.push(userId);
    ownerClause = ' AND user_id = $2';
  }

  // Only 'active' sessions are demoted to 'paused'. A 'promoted' session
  // must keep its status so its PR stays up for vote — pausing the
  // proposer's worker must not yank the PR out of the vote (the vote
  // endpoint and cast-vote handler key off status IN ('promoted','merging')).
  // This mirrors the auto-pause sweeper and LRU eviction, which already
  // refuse to pause promoted sessions. The manual /pause endpoint handles
  // the worker teardown for promoted sessions itself (see routes/sessions.js).
  const { rows } = await pool.query(
    `UPDATE chat_sessions SET status = 'paused'
     WHERE id = $1${ownerClause} AND status = 'active'
       AND source IS DISTINCT FROM 'imported'
     RETURNING id`,
    params
  );
  if (!rows.length) return { paused: false };

  const { rows: sessionRows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = sessionRows[0];
  const appSlug = session?.app_slug;

  // Clear any lingering progress + tear down the worker container. Both
  // are no-ops if there's nothing there (the common auto-pause case:
  // worker was already idle-evicted minutes ago). Staging is left up on
  // purpose — see the note above.
  workerProgress.clear(sessionId);
  await worker.destroyWorker(worker.workerContainerName(sessionId)).catch(() => {});

  const { pushSessionUpdate } = require('./ws');
  pushSessionUpdate({ action: 'paused', sessionId, appSlug });
  log.info('session-lifecycle', 'Session paused', { sessionId, reason });

  return { paused: true, appSlug };
}

// Demand-driven global-cap eviction. Called when a new session is needed
// (create or resume) but the platform is at the global cap. Pauses the
// globally least-recently-active 'active' session that has been idle
// longer than `graceMs` and isn't mid-turn — freeing a slot immediately
// rather than making the requester wait for the slow background auto-
// pause. The grace window protects anyone actively working: only
// sessions idle past it are eligible victims.
//
// Cross-user by design: under contention, an idle session belonging to
// any user can be paused to admit a new one. The victim's worker is
// already long gone (idle-evicted), so reopening auto-resumes cleanly.
//
// Params:
//   pool             - pg pool
//   graceMs          - minimum idle time (ms) a session must exceed to be
//                      an eviction candidate. <= 0 disables (returns
//                      {freed:false} without touching anything).
//   excludeSessionId - optional id to never evict (e.g. the session being
//                      resumed).
//
// Returns { freed: boolean, sessionId?: number }.
async function freeGlobalSlot({ pool, graceMs, excludeSessionId = null }) {
  if (!graceMs || graceMs <= 0) return { freed: false };

  const params = [graceMs];
  let exclude = '';
  if (excludeSessionId != null) {
    params.push(excludeSessionId);
    exclude = ' AND id <> $2';
  }

  const { rows } = await pool.query(
    `SELECT id FROM chat_sessions
     WHERE status = 'active'
       AND source IS DISTINCT FROM 'imported'
       AND last_activity_at < NOW() - make_interval(secs => $1::double precision / 1000.0)${exclude}
     ORDER BY last_activity_at ASC
     LIMIT 20`,
    params
  );

  for (const row of rows) {
    // Never evict a session with any turn/pipeline in flight. Native CLI
    // proposal staging has no worker exec, but it owns the same session and
    // must be allowed to finish just like a web coding turn.
    if (isSessionBusy(row.id)) continue;
    const { paused } = await pauseSession({ pool, sessionId: row.id, reason: 'pressure' });
    if (paused) {
      log.info('session-lifecycle', 'Freed global slot under pressure', { sessionId: row.id });
      return { freed: true, sessionId: row.id };
    }
  }
  return { freed: false };
}

// Tear down a session's staging preview (container + cloned DB + Caddy
// route) WITHOUT changing the session's status. This is the staging GC
// path — pausing no longer does it, so a separate, longer-horizon
// sweeper reclaims staging from sessions that have gone cold. Nulls the
// staging_* columns so a repeat sweep treats it as already reclaimed and
// so a later /resume + push rebuilds fresh.
//
// Never call this for 'promoted'/'merging' sessions — their preview
// backs the group's PR vote. The sweeper query enforces that; this
// function just does the teardown it's told to.
async function teardownStagingForSession({ pool, sessionId, reason = 'idle' }) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = rows[0];
  if (!session || !session.staging_container_id) return { torn: false };

  // #851: teardownStaging owns the nulling and now reports whether the
  // container actually went away. On a leak the row deliberately still names
  // the survivor so the stale-preview sweeper can retry through the same
  // chokepoint — so this must NOT null the columns behind its back (which is
  // exactly how ten production previews became untracked orphans) and must
  // not announce a teardown that didn't happen.
  const result = await staging.teardownStaging(session, { slug: session.app_slug })
    .catch((err) => {
      log.warn('session-lifecycle', 'Staging teardown threw', { sessionId, err: err.message });
      return { removed: false, leaked: true };
    });
  if (result && result.leaked) {
    log.warn('session-lifecycle', 'Staging GC left a container behind — link kept for retry', {
      sessionId, reason,
    });
    return { torn: false, leaked: true };
  }

  const { pushSessionUpdate } = require('./ws');
  pushSessionUpdate({ action: 'staging_torn_down', sessionId, appSlug: session.app_slug });
  log.info('session-lifecycle', 'Staging torn down (GC)', { sessionId, reason });
  return { torn: true };
}

// Archive a session. Reversible now: it tears down the live resources
// (staging + worker) and closes the PR, but KEEPS the CC volume + branch
// so /unarchive can restore it. The CC volume is only destroyed later by
// purgeArchivedCc once the retention window elapses (or immediately when
// purgeCc=true, for callers that want the old hard-delete).
//
// Params:
//   pool, sessionId
//   userId  - optional owner scope (HTTP authz). Omit for system actions.
//   reason  - 'manual' | 'stale-pr' | ...
//   purgeCc - destroy the CC volume immediately (skip retention). Default
//             false. The activeWorkers in-flight set (routes/sessions.js)
//             is cleared by the HTTP handler, not here.
// Returns { archived: boolean, appSlug?: string }.
async function archiveSession({ pool, sessionId, userId = null, reason = 'manual', purgeCc = false }) {
  const params = [sessionId];
  let ownerClause = '';
  if (userId != null) {
    params.push(userId);
    ownerClause = ' AND user_id = $2';
  }

  const { rows } = await pool.query(
    `UPDATE chat_sessions SET status = 'archived', archived_at = NOW()
     WHERE id = $1${ownerClause} AND status IN ('active', 'promoted', 'paused')
     RETURNING id`,
    params
  );
  if (!rows.length) return { archived: false };

  // owner_username feeds the PR-withdrawn group-chat line (#200). The
  // manual archive endpoint is owner-scoped, so when userId is present
  // the session owner IS the actor. LEFT JOIN: a missing user row must
  // not block the archive — the message just falls back to actor-less.
  const { rows: sessionRows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.repo_url, u.username AS owner_username
     FROM chat_sessions cs
     JOIN apps a ON cs.app_id = a.id
     LEFT JOIN users u ON u.id = cs.user_id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = sessionRows[0];
  const appSlug = session?.app_slug;

  if (session?.staging_container_id) {
    // Same contract as teardownStagingForSession above (#851): the chokepoint
    // nulls the columns itself once removal is CONFIRMED, and a leak keeps
    // them so the sweeper can retry. The archive itself proceeds regardless —
    // closing the PR and changing status must not hinge on docker.
    const result = await staging.teardownStaging(session, { slug: appSlug })
      .catch((err) => {
        log.warn('session-lifecycle', 'Staging teardown threw on archive', { sessionId, err: err.message });
        return { removed: false, leaked: true };
      });
    if (result && result.leaked) {
      log.warn('session-lifecycle', 'Archive left a staging container behind — link kept for retry', {
        sessionId, reason,
      });
    }
  }

  if (session?.pr_number) {
    const [owner, repo] = ownerRepo(session.repo_url);
    if (owner) await github.closePR(owner, repo, session.pr_number).catch((err) => {
      log.warn('session-lifecycle', 'Failed to close PR on archive', { sessionId, err: err.message });
    });

    // #200: announce the withdrawal in group chat, completing the PR
    // lifecycle feed (promote/merge already post there — a withdrawn PR
    // otherwise vanishes silently). Posted regardless of closePR's
    // outcome: the close is best-effort and the PR leaves the vote
    // panel either way. Own catch so a chat failure never fails the
    // archive itself.
    const label = session.pr_title
      ? `PR #${session.pr_number} — ${session.pr_title}`
      : `PR #${session.pr_number}`;
    // Rejection (auto-takedown) gets its own line so the lifecycle feed reads
    // correctly: the group voted it down rather than it just going quiet.
    const content = reason === 'auto-rejected'
      ? `${label} was closed by the group (more No than Yes, not enough support)`
      : userId != null && session.owner_username
        ? `${session.owner_username} withdrew ${label}`
        : `${label} was withdrawn (no vote activity)`;
    try {
      const { sendSystemMessage } = require('./ws');
      await sendSystemMessage(pool, session.app_id, content, 'system');
    } catch (err) {
      log.warn('session-lifecycle', 'Failed to post PR-withdrawn chat message', { sessionId, err: err.message });
    }
  }

  workerProgress.clear(sessionId);
  await worker.destroyWorker(worker.workerContainerName(sessionId)).catch(() => {});

  // A withdrawn / voted-down declaration proposal takes its held secret
  // value with it: the group didn't approve the change, so the value must
  // stop existing rather than sit around waiting for a PR that will never
  // merge (services/pending-secrets.js). This covers every abandonment
  // path, since they all funnel through archiveSession. Best-effort — the
  // panel also treats a row whose session left the live statuses as dead.
  await require('./pending-secrets').discardForSession(pool, sessionId)
    .catch((err) => log.warn('session-lifecycle', 'Pending-declaration discard failed', {
      sessionId, err: err.message,
    }));

  // Retention: keep the CC volume so /unarchive can restore conversation
  // memory. purgeArchivedCc (or purgeCc=true here) destroys it later.
  if (purgeCc) {
    await worker.destroyCcVolume(sessionId).catch(() => {});
    await pool.query(`UPDATE chat_sessions SET cc_purged = TRUE WHERE id = $1`, [sessionId]);
  }

  const { pushSessionUpdate, pushIssueUpdate } = require('./ws');
  pushSessionUpdate({ action: 'archived', sessionId, appSlug });
  // Issues this session's dispatches declared lose their contribution to
  // the derived "In progress" chip the moment the row leaves the live
  // statuses — tell open Dev panels to refetch. This one hook covers every
  // abandonment path (manual withdraw, vote-down auto-takedown, stale-PR
  // sweeper): they all funnel through archiveSession.
  if (Array.isArray(session?.linked_issues) && session.linked_issues.length) {
    pushIssueUpdate({
      action: 'updated', source: 'session_archived',
      appSlug, appId: session.app_id,
    });
  }
  log.info('session-lifecycle', 'Session archived', { sessionId, reason, purgeCc });
  return { archived: true, appSlug };
}

// Reverse an archive (within the retention window). Restores the session
// to 'paused' — reopening it then goes through the normal auto-resume
// path. Best-effort reopens the PR; if that fails (branch gone, install
// restrictions), the session still has its branch + (unless purged) its
// CC memory, and the user can propose a fresh PR.
//
// Returns { unarchived: boolean, ccPurged?: boolean, prReopened?: boolean }.
async function unarchiveSession({ pool, sessionId, userId = null }) {
  const params = [sessionId];
  let ownerClause = '';
  if (userId != null) {
    params.push(userId);
    ownerClause = ' AND user_id = $2';
  }

  const { rows } = await pool.query(
    `UPDATE chat_sessions SET status = 'paused', archived_at = NULL
     WHERE id = $1${ownerClause} AND status = 'archived'
     RETURNING id`,
    params
  );
  if (!rows.length) return { unarchived: false };

  const { rows: sessionRows } = await pool.query(
    `SELECT cs.*, a.slug as app_slug, a.repo_url
     FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
     WHERE cs.id = $1`,
    [sessionId]
  );
  const session = sessionRows[0];

  let prReopened = false;
  if (session?.pr_number) {
    const [owner, repo] = ownerRepo(session.repo_url);
    if (owner) {
      try {
        await github.reopenPR(owner, repo, session.pr_number);
        prReopened = true;
      } catch (err) {
        log.warn('session-lifecycle', 'Could not reopen PR on unarchive (branch may need re-proposing)', { sessionId, err: err.message });
        // Self-heal: when GitHub definitively reports the PR
        // closed-unmerged, drop the dead reference (keep pr_title for
        // reuse) so the promote route's lazy PR creation mints a fresh
        // PR on the same branch. Carrying the closed pr_number forward
        // is what made a re-promoted proposal permanently unmergeable
        // (session 2398 / PR #26). A transient GET failure leaves the
        // row as-is — the promote-time reopen guard still catches it.
        try {
          const pr = await github.getPR(owner, repo, session.pr_number);
          if (pr && pr.state === 'closed' && !pr.merged) {
            await pool.query(
              `UPDATE chat_sessions SET pr_number = NULL, pr_url = NULL WHERE id = $1`,
              [sessionId]
            );
            log.info('session-lifecycle', 'Cleared closed-unmerged PR reference on unarchive', {
              sessionId, pr: session.pr_number,
            });
          }
        } catch (checkErr) {
          log.warn('session-lifecycle', 'PR state check on unarchive failed (leaving PR reference)', {
            sessionId, err: checkErr.message,
          });
        }
      }
    }
  }

  const { pushSessionUpdate, pushIssueUpdate } = require('./ws');
  pushSessionUpdate({ action: 'unarchived', sessionId, appSlug: session?.app_slug });
  // Mirror of the archive-time broadcast: a restored session's linked
  // issues regain their "In progress" chip on the next panel refetch.
  if (Array.isArray(session?.linked_issues) && session.linked_issues.length) {
    pushIssueUpdate({
      action: 'updated', source: 'session_unarchived',
      appSlug: session?.app_slug, appId: session?.app_id,
    });
  }
  log.info('session-lifecycle', 'Session unarchived', { sessionId, prReopened, ccPurged: !!session?.cc_purged });
  return { unarchived: true, ccPurged: !!session?.cc_purged, prReopened };
}

// Hard GC for the retention window: destroy the CC volume of an archived
// session so its conversation memory stops occupying disk. Idempotent —
// flips cc_purged so the sweeper won't revisit it. The row + branch
// survive; /unarchive still works but with fresh Claude memory.
async function purgeArchivedCc({ pool, sessionId }) {
  await worker.destroyCcVolume(sessionId).catch(() => {});
  await pool.query(`UPDATE chat_sessions SET cc_purged = TRUE WHERE id = $1`, [sessionId]);
  log.info('session-lifecycle', 'Archived CC volume purged (retention elapsed)', { sessionId });
  return { purged: true };
}

module.exports = {
  pauseSession,
  freeGlobalSlot,
  teardownStagingForSession,
  archiveSession,
  unarchiveSession,
  purgeArchivedCc,
};
