'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const llm = require('../services/llm');
const github = require('../services/github');
const prMetadata = require('../services/pr-metadata');
const testingNotes = require('../services/testing-notes');
const staging = require('../services/staging');
const docker = require('../services/docker');
const caddy = require('../services/caddy');
const worker = require('../services/worker');
const workerProgress = require('../services/worker-progress');
const sessionLifecycle = require('../services/session-lifecycle');
const sessionBus = require('../services/session-bus');
const { drainGuard } = require('../services/lifecycle');
const { getAppConventions, getSelfHostedRefuseList } = require('../services/prompts');
const models = require('../services/models');
const limits = require('../services/limits');
const events = require('../services/events');
const { chatLimiter } = require('../middleware/rate-limits');
const appAccess = require('../services/app-access');
// runSyncMain + persistBehindMain now live in services/sync-main.js so
// the conflict-resolver can drive a sync turn without a route-requires-
// route cycle. Re-exported below for backwards compatibility.
const { runSyncMain, persistBehindMain } = require('../services/sync-main');

// Track sessions with active Claude Code workers. The Set lives in a
// shared module so services/sync-main.js writes to the same instance
// the chat handler and server.js's drain logic read.
const { activeWorkers, getActiveWorkerCount } = require('../services/active-workers');

// Per-session stop handles, populated while a chat turn is in flight.
// Shape: { abort: AbortController, workerName: string|null, phase: 'mayor1'|'cc'|'mayor2', stopped: boolean }
// The POST /stop endpoint looks up this record to:
//   1. Abort the in-flight Mayor Anthropic stream (phase 'mayor1').
//   2. `docker stop` the running Claude Code worker (phase 'cc').
// Phase 'mayor2' is intentionally stop-proof — by then CC has already
// pushed a commit + opened a PR and we just want the summary to finish.
const stopRegistry = new Map();

// getActiveWorkerCount is imported from services/active-workers and
// re-exported at the bottom of this module (server.js imports it here).

// Daily LLM-spend caps used to live as hardcoded constants here. They
// now live in the platform_settings table (admin-tunable) and are read
// via src/services/limits.js with a 10s in-process cache. Per-user
// overrides come from users.daily_limit_cents.

// Pull the first ATX-style H1 from a spec's markdown content. Used by
// the spec-share endpoint so the group-chat card can show "Title"
// instead of just "spec v3". Returns null if no H1 is found in the
// first ~30 lines (good enough for AI-generated specs, which always
// start with a heading near the top). Capped at 120 chars so a
// pathologically long heading can't blow up card layouts.
function extractSpecTitle(content) {
  if (!content) return null;
  const lines = content.split('\n');
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const line = lines[i].trim();
    if (line.startsWith('# ') && !line.startsWith('## ')) {
      const t = line.slice(2).trim();
      if (t) return t.slice(0, 120);
    }
  }
  return null;
}

// Card snippet (body preview), with the title line stripped so the
// title doesn't render twice (once as the card heading, once at the
// top of the rendered-markdown snippet). 280 chars is enough for ~4
// lines of preview after the markdown renderer is done with it.
function extractSpecSnippet(content, title) {
  if (!content) return '';
  if (!title) return content.slice(0, 280);
  const lines = content.split('\n');
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (lines[i].trim() === '') continue;
    if (lines[i].trim().startsWith('# ') && !lines[i].trim().startsWith('## ')) {
      start = i + 1;
    }
    break;
  }
  while (start < lines.length && lines[start].trim() === '') start++;
  return lines.slice(start).join('\n').slice(0, 280);
}

// runSyncMain + persistBehindMain moved to services/sync-main.js (see
// the require at the top of this file). They're re-exported below so
// any external importer keeps working.

async function loadSessionSpec(pool, sessionId) {
  const { rows } = await pool.query(
    'SELECT spec_md FROM chat_sessions WHERE id = $1',
    [sessionId]
  );
  return (rows[0] && rows[0].spec_md) || '';
}

// Build the inline spec-preview snippet (F8): cap length but cut on a
// whitespace boundary so we don't slice through a word or an inline
// markdown construct, then append an ellipsis.
function buildSpecPreview(content, max = 400) {
  const text = typeof content === 'string' ? content : '';
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const bound = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  if (bound > max * 0.8) cut = cut.slice(0, bound);
  return `${cut}…`;
}

// Unwrap a whole-document ```markdown fence a scout/spec-author LLM sometimes
// emits around the entire spec (see src/services/spec-format.js for the why
// and the conservative rules). Re-exported below so existing importers and
// tests can keep requiring it from this module.
const { stripSpecWrapperFence } = require('../services/spec-format');

// #27: freeze the current spec content as a new immutable version in
// chat_session_specs and return its version number. Every spec mutation
// (write_spec / edit_spec / scout) calls this and tags its inline spec
// preview card with the returned version, so clicking an OLDER card
// opens exactly the content it represented — instead of always falling
// back to the latest spec. Since #69 retired the manual "Save version"
// route, this is the SOLE writer of new rows in chat_session_specs;
// it uses MAX(version)+1. Best-effort: returns null on failure so the
// card falls back to the latest spec rather than blocking the edit.
async function snapshotSessionSpec(pool, sessionId, content) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO chat_session_specs (session_id, version, content)
       VALUES ($1, COALESCE((SELECT MAX(version) FROM chat_session_specs WHERE session_id = $1), 0) + 1, $2)
       RETURNING version`,
      [sessionId, content]
    );
    return rows[0].version;
  } catch (err) {
    log.warn('sessions', 'Failed to snapshot spec version', { err: err.message, sessionId });
    return null;
  }
}

function sessionRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Per-app visibility gate for every session-id-addressed route below
  // (/api/sessions/:id/...): resolves the session's app and requires
  // collab-level access. 404 on deny so private apps' sessions aren't
  // enumerable; missing sessions fall through to each route's own 404.
  router.use('/api/sessions/:id', appAccess.sessionCollabGuard(pool));

  // GET /api/me/active-sessions
  //   Cross-app view of the current user's non-archived sessions,
  //   each annotated with whether a CC turn is in flight right now.
  //   Used by the dev-chat tab's "Active Sessions (x/y)" panel so a
  //   user can see all their in-progress AI work at a glance — even
  //   from other projects — without flipping through apps.
  //
  //   "busy" comes from the same in-process state the per-session
  //   /status endpoint uses: activeWorkers (chat handler's in-flight
  //   window) OR worker.isInFlight (warm-registry exec flag). The
  //   container-status fallback is intentionally NOT used here, for
  //   the same warm-CC reason described in /api/sessions/:id/status.
  //
  //   The result includes paused sessions too — the panel's job is
  //   "see all your dev work across apps and resume any of it", and
  //   paused rows are exactly what makes that useful.
  //
  //   "totals" lets the caller render the (x/y) header without a
  //   second pass through the array:
  //     - active = active + promoted (the sessions counting against
  //                the 3-slot cap; visually green/violet in the UI)
  //     - paused = paused-status sessions (no warm worker)
  //     - busy   = subset of `active` where CC is mid-turn right now
  //     - total  = active + paused (i.e. every non-archived row we returned)
  router.get('/api/me/active-sessions', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT cs.id, cs.branch_name, cs.pr_number, cs.pr_url, cs.pr_title,
                cs.status, cs.linked_issues, cs.created_at,
                a.slug AS app_slug, a.name AS app_name
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.user_id = $1 AND cs.status IN ('active', 'promoted', 'paused')
         ORDER BY cs.created_at DESC`,
        [req.user.id]
      );
      const sessions = rows.map((s) => ({
        ...s,
        busy: activeWorkers.has(s.id) || worker.isInFlight(s.id),
      }));
      const totals = sessions.reduce(
        (acc, s) => {
          if (s.status === 'paused') acc.paused += 1;
          else acc.active += 1; // 'active' or 'promoted'
          if (s.busy) acc.busy += 1;
          return acc;
        },
        { active: 0, paused: 0, busy: 0 }
      );
      totals.total = sessions.length;
      res.json({ sessions, totals });
    } catch (err) {
      log.error('sessions', 'Failed to list active sessions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List sessions for an app (user's own)
  router.get('/api/apps/:slug/sessions', async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(
        pool, req.params.slug, req.user, 'collab', appAccess.ACCESS_COLUMNS
      );
      if (!app) return res.status(404).json({ error: 'App not found' });
      const appRows = [app];

      const { rows } = await pool.query(
        `SELECT id, branch_name, pr_number, pr_url, pr_title, staging_url, status, linked_issues, behind_main, created_at
         FROM chat_sessions
         WHERE app_id = $1 AND user_id = $2
         ORDER BY created_at DESC`,
        [appRows[0].id, req.user.id]
      );

      res.json({ sessions: rows });
    } catch (err) {
      log.error('sessions', 'Failed to list sessions', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Create a new session (branch + PR)
  router.post('/api/apps/:slug/sessions', drainGuard, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });

      // Check staging container limits
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions WHERE user_id = $1 AND status IN ('active', 'promoted')`,
        [req.user.id]
      );
      if (parseInt(countRows[0].cnt) >= config.maxUserSessions) {
        return res.status(429).json({ error: `You already have ${config.maxUserSessions} active sessions. Pause, archive, or merge one first.` });
      }

      const { rows: globalRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions WHERE status IN ('active', 'promoted')`
      );
      if (parseInt(globalRows[0].cnt) >= config.maxGlobalSessions) {
        // At the global cap: try to reclaim a slot from a globally idle
        // session (idle past the pressure grace window, not mid-turn)
        // instead of making this user wait for the slow 2h auto-pause.
        // Only 429 if everything is genuinely active.
        const { freed } = await sessionLifecycle.freeGlobalSlot({
          pool, graceMs: config.sessionPressureGraceMs,
        });
        if (!freed) {
          return res.status(429).json({ error: 'Platform is at capacity right now. Try again in a few minutes.' });
        }
      }

      const branchName = `dev/${req.user.username}-${Date.now()}`;

      // Create branch on GitHub (PR created later after first commit)
      if (github.isEnabled() && app.repo_url) {
        try {
          const [, repoOwner, repoName] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
          if (repoOwner && repoName) {
            await github.createBranch(repoOwner, repoName, branchName);
          }
        } catch (err) {
          log.warn('sessions', 'GitHub branch creation failed (continuing)', { err: err.message });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING *`,
        [app.id, req.user.id, branchName]
      );

      log.info('sessions', 'Session created', { sessionId: rows[0].id, branch: branchName });
      events.record(pool, {
        type: events.EVENT_TYPES.DEV_SESSION_STARTED,
        userId: req.user.id,
        appId: app.id,
        sessionId: rows[0].id,
      });
      res.status(201).json({ session: rows[0] });
    } catch (err) {
      log.error('sessions', 'Failed to create session', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get session with message history
  router.get('/api/sessions/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });

      // Viewing a session counts as activity so the auto-pause sweeper
      // doesn't pause a session the user is actively reading. Fire-and-
      // forget — the view shouldn't block on this write, and a missed
      // bump just means the next chat turn / open re-marks it.
      pool.query(`UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`, [req.params.id])
        .catch((err) => log.warn('sessions', 'activity bump on view failed', { err: err.message }));

      const { rows: messages } = await pool.query(
        `SELECT id, role, content, model, token_count, cost_cents, metadata, created_at
         FROM chat_session_messages
         WHERE session_id = $1
         ORDER BY id ASC`,
        [req.params.id]
      );

      res.json({ session: rows[0], messages });
    } catch (err) {
      log.error('sessions', 'Failed to get session', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/activity
  //   Lightweight heartbeat from the dev-chat UI. While the user has a
  //   session open and the tab visible, the client pings this so
  //   last_activity_at stays fresh — that's what lets the auto-pause
  //   timer run on a short (~5 min) worker-eviction-aligned window
  //   without pausing sessions someone is actively reading. One indexed
  //   UPDATE; only bumps 'active'/'promoted' rows owned by the caller.
  router.post('/api/sessions/:id/activity', async (req, res) => {
    try {
      await pool.query(
        `UPDATE chat_sessions SET last_activity_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'promoted')`,
        [req.params.id, req.user.id]
      );
      res.json({ ok: true });
    } catch (err) {
      // Best-effort — a failed heartbeat just risks an earlier auto-pause,
      // which is recoverable (reopening auto-resumes). Don't 500-spam.
      res.json({ ok: false });
    }
  });

  // Archive a session. Reversible: tears down staging + worker and closes
  // the PR, but KEEPS the CC volume + branch so /unarchive can restore it
  // within the retention window (a background GC purges the volume only
  // after ARCHIVED_RETENTION_MS). Use the service so the stale-PR sweeper
  // archives the exact same way.
  router.post('/api/sessions/:id/archive', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);

      // Release any in-flight bookkeeping first (archiving mid-turn).
      if (activeWorkers.has(sessionId)) {
        activeWorkers.delete(sessionId);
        workerProgress.clear(sessionId);
      }

      const { archived } = await sessionLifecycle.archiveSession({
        pool, sessionId, userId: req.user.id, reason: 'manual',
      });
      if (!archived) return res.status(404).json({ error: 'Session not found or already archived' });
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Archive failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/unarchive
  //   Reverse an archive (within the retention window). Restores the
  //   session to 'paused' and best-effort reopens the PR; reopening it in
  //   the UI then auto-resumes via the normal path. If the CC volume was
  //   already GC'd (cc_purged), the restore still works but Claude starts
  //   fresh — we surface that so the UI can warn.
  router.post('/api/sessions/:id/unarchive', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);
      const { unarchived, ccPurged, prReopened } = await sessionLifecycle.unarchiveSession({
        pool, sessionId, userId: req.user.id,
      });
      if (!unarchived) return res.status(404).json({ error: 'Session not found or not archived' });
      res.json({ ok: true, ccPurged: !!ccPurged, prReopened: !!prReopened });
    } catch (err) {
      log.error('sessions', 'Unarchive failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/pause
  //   Reversible counterpart to /archive. The point is to free the
  //   3-active-session slot without throwing away anything the user
  //   would want back on /resume:
  //     - Worker container: destroyed (frees the slot).
  //     - Staging container: torn down (cheap to recreate from the
  //       branch on resume).
  //     - CC session volume: PRESERVED. This is the bit that lets
  //       --resume <cc_session_id> still work after a resume.
  //     - PR: LEFT OPEN. Closing+reopening PRs gets messy on GitHub
  //       (auto-closed PRs can only be reopened by the closer; some
  //       installations refuse it entirely), so pause is purely a
  //       worker/container thing as far as GitHub is concerned.
  //     - Branch: untouched.
  //   Idempotent on the status side — re-pausing a paused session is
  //   a no-op rather than an error, since the state we'd land in is
  //   the same.
  router.post('/api/sessions/:id/pause', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);

      // Drop in-flight bookkeeping first so pausing mid-turn (the user
      // pausing to abort a running turn) releases the activeWorkers slot.
      // pauseSession() tears down the container + staging itself.
      if (activeWorkers.has(sessionId)) {
        activeWorkers.delete(sessionId);
        workerProgress.clear(sessionId);
      }

      const { paused } = await sessionLifecycle.pauseSession({
        pool, sessionId, userId: req.user.id, reason: 'manual',
      });
      if (!paused) {
        // Either it doesn't exist, isn't ours, or is already paused/archived,
        // or it's a promoted session (which pauseSession deliberately refuses
        // to demote so its PR stays up for vote).
        const { rows: check } = await pool.query(
          `SELECT id, status FROM chat_sessions WHERE id = $1 AND user_id = $2`,
          [sessionId, req.user.id]
        );
        // Soft 200 if it's already paused so the UI can no-op the button click.
        if (check[0] && check[0].status === 'paused') return res.json({ ok: true, alreadyPaused: true });
        // Promoted: honor the user's intent to free the warm worker (same
        // teardown pauseSession does for 'active'), but leave status =
        // 'promoted' so the PR keeps showing its voting buttons and stays
        // votable. The vote endpoint and cast-vote handler key off the
        // promoted status, so flipping it here would silently pull the PR
        // from the vote — exactly the bug we're fixing.
        if (check[0] && check[0].status === 'promoted') {
          workerProgress.clear(sessionId);
          await worker.destroyWorker(worker.workerContainerName(sessionId)).catch(() => {});
          return res.json({ ok: true, keptPromoted: true });
        }
        return res.status(404).json({ error: 'Session not found or cannot be paused' });
      }
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Pause failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/resume
  //   Inverse of /pause. Flips status back to 'active' so the next
  //   chat turn can lazily spawn a worker (CC volume is still on
  //   disk, so --resume <cc_session_id> picks up where we left off).
  //   Also the auto-resume target: the dev-chat UI calls this when a
  //   user opens a paused session.
  //
  //   Cap handling:
  //     - Global cap: refuse if the platform-wide active+promoted count
  //       is already at maxGlobalSessions (a flood of simultaneous
  //       resumes shouldn't blow past the concurrency ceiling).
  //     - Per-user cap: if the user is already at maxUserSessions, the
  //       default (sessionLruOnResume) is to auto-pause their least-
  //       recently-active session to make room, so reopening always
  //       works. Set SESSION_LRU_ON_RESUME=false to keep the old hard
  //       429. If every other session is mid-turn (can't be paused), we
  //       fall back to a 429.
  //   We deliberately do NOT pre-spawn the worker here; first-turn lazy
  //   boot is what every other path uses.
  router.post('/api/sessions/:id/resume', async (req, res) => {
    try {
      const sessionId = parseInt(req.params.id, 10);

      const { rows: globalRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions WHERE status IN ('active', 'promoted')`
      );
      if (parseInt(globalRows[0].cnt) >= config.maxGlobalSessions) {
        // At the global cap: reclaim a slot from a globally idle session
        // (not this one) rather than blocking the reopen. Only 429 if
        // everything else is genuinely active.
        const { freed } = await sessionLifecycle.freeGlobalSlot({
          pool, graceMs: config.sessionPressureGraceMs, excludeSessionId: sessionId,
        });
        if (!freed) {
          return res.status(429).json({ error: 'Platform is at capacity right now. Try again in a few minutes.' });
        }
      }

      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
         WHERE user_id = $1 AND status IN ('active', 'promoted')`,
        [req.user.id]
      );
      if (parseInt(countRows[0].cnt) >= config.maxUserSessions) {
        if (!config.sessionLruOnResume) {
          return res.status(429).json({ error: `You already have ${config.maxUserSessions} active sessions. Pause one first to free a slot.` });
        }
        // LRU: pause the user's least-recently-active 'active' session
        // (not 'promoted' — those await merge votes) to free a slot.
        // Skip any that are mid-turn; if none can be freed, 429.
        const { rows: lruRows } = await pool.query(
          `SELECT id FROM chat_sessions
           WHERE user_id = $1 AND status = 'active' AND id <> $2
           ORDER BY last_activity_at ASC`,
          [req.user.id, sessionId]
        );
        let freed = false;
        for (const victim of lruRows) {
          if (worker.isInFlight(victim.id)) continue;
          const { paused } = await sessionLifecycle.pauseSession({
            pool, sessionId: victim.id, userId: req.user.id, reason: 'lru',
          });
          if (paused) { freed = true; break; }
        }
        if (!freed) {
          return res.status(429).json({ error: 'Your other sessions are busy finishing turns. Try again in a moment.' });
        }
      }

      const { rows } = await pool.query(
        `UPDATE chat_sessions SET status = 'active', last_activity_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'paused'
         RETURNING id, app_id`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found or not paused' });

      const { rows: sessionRows } = await pool.query(
        `SELECT a.slug as app_slug
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1`,
        [sessionId]
      );
      const appSlug = sessionRows[0]?.app_slug;

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'resumed', sessionId, appSlug });
      log.info('sessions', 'Session resumed', { sessionId });

      // #8: if the resumed session is behind main, kick off a silent
      // sync in the background. The HTTP response returns immediately
      // (the UI doesn't wait for the sync to complete) — drift
      // accounting is best-effort and the dev-chat banner will
      // update via the session_update WS event when it lands. We
      // run this only when the session has a known positive drift
      // count from a prior turn; sessions that never ran a turn
      // have behind_main=0 and the next /chat turn will populate it.
      const { rows: driftRows } = await pool.query(
        'SELECT behind_main FROM chat_sessions WHERE id = $1',
        [sessionId]
      );
      if ((driftRows[0]?.behind_main || 0) > 0) {
        // Fire-and-forget. Failures are logged but don't bubble up;
        // the user explicitly clicking "Sync with main" later will
        // re-attempt with full surface area for errors.
        runSyncMain(config, pool, sessionId).catch((err) => {
          log.warn('sessions', 'Background sync-on-resume failed', {
            sessionId, err: err.message,
          });
        });
      }

      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Resume failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #8: POST /api/sessions/:id/sync-main
  //   Merge origin/main into the session's branch. Runs a worker turn
  //   in MODE=sync (see worker/run-cc.sh). Clean merges are
  //   commit+push only (no CC, no LLM spend); conflicts dispatch CC
  //   with a resolution-only prompt and abort cleanly if CC can't
  //   resolve.
  //
  //   Owner-only. Returns the syncResult so the UI can route messaging:
  //     already_synced — nothing to do
  //     clean          — merged + pushed without LLM
  //     resolved       — CC resolved conflicts; merged + pushed
  //     conflict       — CC couldn't resolve; merge aborted, no push
  router.post('/api/sessions/:id/sync-main', drainGuard, async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    if (Number.isNaN(sessionId)) return res.status(400).json({ error: 'Bad session id' });

    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const session = rows[0];
      if (!['active', 'promoted'].includes(session.status)) {
        return res.status(409).json({
          error: `Cannot sync a ${session.status} session — resume or unarchive first.`,
        });
      }

      const result = await runSyncMain(config, pool, sessionId, { sessionRow: session });
      res.json(result);
    } catch (err) {
      log.error('sessions', 'sync-main failed', { sessionId, err: err.message });
      res.status(500).json({ error: err.message || 'Internal server error' });
    }
  });

  // Send a message in a dev chat session — Mayor + Claude Code pattern.
  // chatLimiter caps a single user at 30 chat turns/min so a runaway
  // script can't drain their daily LLM cap before checkBudget() can
  // even respond. See src/middleware/rate-limits.js.
  router.post('/api/sessions/:id/chat', chatLimiter, drainGuard, async (req, res) => {
    const { message, model } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message required' });
    }

    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url,
                a.self_hosted as app_self_hosted
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2
           AND cs.status IN ('active', 'promoted')`,
        [req.params.id, req.user.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Active session not found' });
      const session = sessionRows[0];

      // Resolve the caller's BYOK key once up front (#30). If present,
      // Mayor + CC calls route through it and we skip the shared-budget
      // check entirely — users paying Anthropic directly aren't subject
      // to our admin-key cap.
      let userApiKey = null;
      try {
        const { rows: keyRows } = await pool.query(
          'SELECT anthropic_key_enc FROM users WHERE id = $1',
          [req.user.id]
        );
        if (keyRows[0]?.anthropic_key_enc) {
          const secrets = require('../services/secrets');
          userApiKey = secrets.decrypt(keyRows[0].anthropic_key_enc, config.jwtSecret);
        }
      } catch (err) {
        log.warn('sessions', 'Failed to load user API key', { userId: req.user.id, err: err.message });
      }

      if (!userApiKey) {
        const budgetCheck = await checkBudget(pool, req.user.id);
        if (budgetCheck.error) return res.status(429).json({ error: budgetCheck.error });
      }

      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
        [session.id, message.trim()]
      );

      // Mark the session as freshly active so the auto-pause sweeper
      // leaves it alone (see server.js session sweeper + schema
      // last_activity_at). A chat turn is the strongest activity signal.
      await pool.query(
        `UPDATE chat_sessions SET last_activity_at = NOW() WHERE id = $1`,
        [session.id]
      );

      // Validate against the server-side allowlist (src/services/models.js).
      // A bogus or unrecognized `model` falls back to the default — this
      // is the user-facing escape hatch for HIGH #2 (client-controlled
      // model name). The same allowlist powers the UI dropdown via
      // GET /api/models, so there's no drift between what the UI
      // offers and what the server accepts.
      const selectedModel = models.resolve(model);

      // SSE response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const { broadcastGlobal } = require('../services/ws');
      const seqPrefix = Date.now().toString(36);
      let eventSeq = 0;
      // Event types that are ONLY meaningful on the active SSE stream. They
      // must not also be broadcast on the global WebSocket because both
      // channels share a _seq-based dedup on the client: if a token arrived
      // first on the WS (which has no 'token' handler) it would be silently
      // swallowed, and the matching SSE delivery would then be deduped-skipped
      // — the mayor's response would be written to the DB but never appear in
      // the live UI until the user refreshes.
      const SSE_ONLY = new Set(['token', 'usage', 'error', 'mayor_reasoning']);
      const send = (type, data) => {
        const seq = `${seqPrefix}-${++eventSeq}`;
        const event = { type, _seq: seq, ...data };
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
        if (!SSE_ONLY.has(type)) {
          broadcastGlobal({ type: 'session_event', sessionId: session.id, event: type, ...event });
        }
        // Also publish to the per-session event bus so a client whose POST
        // SSE connection drops can reconnect via GET /events and replay any
        // events it missed (EventSource auto-reconnect + Last-Event-Id).
        // Token/usage/error/mayor_reasoning are intentionally included here
        // — unlike the global WS they're scoped to this session only, so
        // there's no cross-session leakage and the client's existing seq
        // dedup handles any overlap with the primary stream.
        sessionBus.publish(session.id, event);
      };

      // Locals used across multiple branches of the CC flow. Previously these
      // were implicit globals which leaked across concurrent requests.
      let ccLog = null;
      let stagingUrl = null;

      // Register a stop handle for this turn so POST /stop can cancel the
      // in-flight Mayor stream and/or running Claude Code worker. We reuse
      // a single AbortController across both Mayor phases (phase-2 ignores
      // it anyway, see below). Any prior handle for this session is torn
      // down defensively — in theory the previous turn's finally already
      // cleared it, but an unclean shutdown could leave a stale entry.
      const stopHandle = {
        abort: new AbortController(),
        // Diagnostic only with long-lived workers — the warm container
        // is preserved across stop. Real signal travels through
        // execChild below.
        workerName: null,
        // Set by execInWorker.onChild to the host-side `docker exec`
        // child process. POST /stop SIGTERMs this so just the in-flight
        // turn dies, leaving the warm container ready for the next
        // dispatch. Cleared on exec completion.
        execChild: null,
        phase: 'mayor1',
        stopped: false,
        stoppedBy: null,
      };
      const prior = stopRegistry.get(session.id);
      if (prior && prior !== stopHandle) {
        try { prior.abort.abort(); } catch {}
      }
      stopRegistry.set(session.id, stopHandle);

      const setPhase = (phase) => {
        stopHandle.phase = phase;
        send('phase', { phase });
      };

      try {
        // Parse repo info
        const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];

        if (!repoOwner || !repoName) {
          send('error', { error: 'No GitHub repo configured for this app' });
          res.end();
          return;
        }

        // Each status event is its own immutable system message
        const sendStatus = async (text, metadata) => {
          send('status', { text, ...(metadata || {}) });
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, metadata)
             VALUES ($1, 'system', $2, $3)`,
            [session.id, text, JSON.stringify(metadata || {})]
          ).catch(() => {});
        };

        await sendStatus('Thinking about your request...');

        // Pull user+mayor turns AND the coding-agent's final summaries
        // (stored as system messages with metadata.ccOutput). Without
        // those the Mayor has no visibility into what got built in
        // earlier turns, so questions like "what was the fix?" would
        // dispatch CC unnecessarily just to re-discover the answer.
        const { rows: history } = await pool.query(
          `SELECT role, content, metadata FROM chat_session_messages
           WHERE session_id = $1
             AND (role IN ('user', 'assistant')
                  OR (role = 'system' AND metadata->>'ccOutput' IS NOT NULL))
           ORDER BY id ASC`,
          [session.id]
        );

        // Same "in-flight only — warm-idle ≠ busy" rationale as the
        // /status endpoint above. Pre-warm-CC, "container running"
        // meant "claude actively running"; now it just means "wrapper
        // alive". Treating warm-idle as busy here would falsely lock
        // the Mayor out of dispatch_scout / dispatch_claude_code for
        // the entire idle-eviction window of a previous turn.
        const isWorkerBusy = activeWorkers.has(session.id) || worker.isInFlight(session.id);
        // Inject the live spec_md into the Mayor's system prompt every
        // turn so revisions anchor against real content instead of
        // regenerating from scratch. Re-read before phase-2 below in
        // case the tool we're about to run mutated it.
        let currentSpec = await loadSessionSpec(pool, session.id);
        const prContext = session.pr_number
          ? { prNumber: session.pr_number, prTitle: session.pr_title, status: session.status }
          : null;
        let mayorPrompt = getMayorSystemPrompt(session.app_name, isWorkerBusy, currentSpec, !!session.app_self_hosted, prContext);
        const messages = buildMayorMessages(history);

        if (!llm.isEnabled()) {
          send('error', { error: 'LLM not configured' });
          send('done', {});
          res.end();
          return;
        }

        // --- Phase 1: Mayor turn with dispatch_claude_code available ---
        //
        // The model decides — as a first-class tool call — whether to
        // hand off to the coding agent. No more [CHAT_ONLY] prefix
        // sentinel: if the user's message is a chat/clarification, the
        // model just responds in text and stops. If it's a concrete
        // code change, the model emits a short plan text block + a
        // tool_use block. We run the tool, feed the result back as a
        // `tool_result`, and re-enter the model for a short wrap-up
        // turn.
        // The Mayor sees three tools when no worker is busy. The
        // spec-edit tool is gated by spec emptiness: write_spec for the
        // initial-empty case (no anchor to edit against), edit_spec
        // once the spec has content (anchored replacement preserves
        // accepted text). Exactly one of the two is exposed to the API
        // per turn, mirroring the prompt's tool description. Their
        // priority ordering and the rule against combining the spec
        // tool with dispatch_claude_code in one turn are enforced both
        // by the system prompt AND by the resolution code below —
        // models sometimes ignore prose constraints, so we
        // belt-and-suspenders it server-side.
        const specEditTool = currentSpec.trim() ? EDIT_SPEC_TOOL : WRITE_SPEC_TOOL;
        // list_github_issues stays available even when a worker is busy:
        // it's read-only and cheap, and reading the tracker while a build
        // runs is a legitimate chat action. The dispatch/spec tools remain
        // gated by isWorkerBusy as before.
        const tools = isWorkerBusy
          ? [LIST_GITHUB_ISSUES_TOOL]
          : [DISPATCH_TOOL, DISPATCH_SCOUT_TOOL, specEditTool, LIST_GITHUB_ISSUES_TOOL];

        setPhase('mayor1');
        let mayor1;
        // The conversation we feed the Mayor. list_github_issues is a
        // read-only DATA tool: when the Mayor calls it, we resolve it
        // in-process, append the issues as a tool_result, and re-invoke so
        // the Mayor reasons with them in the SAME turn. This loop drains
        // issue-calls out BEFORE the terminal-tool (dispatch/spec) selection
        // below, so in the common case mayor1.rawContent carries no dangling
        // list_github_issues tool_use into phase-2.
        let mayorConvo = messages;
        let issuesIters = 0;
        try {
          for (;;) {
            mayor1 = await llm.streamChat({
              messages: mayorConvo,
              systemPrompt: mayorPrompt,
              model: selectedModel,
              tools,
              signal: stopHandle.abort.signal,
              onToken: (text) => send('token', { text }),
              apiKey: userApiKey,
            });

            const issuesCalls = mayor1.toolUses.filter((t) => t.name === 'list_github_issues');
            // Parallel tool use is enabled, so the Mayor may emit
            // list_github_issues ALONGSIDE a terminal tool in one response.
            // If a terminal tool is present we must NOT re-invoke here: the
            // re-invocation only answers the issues tool_use, leaving the
            // terminal tool_use dangling -> Anthropic 400. Break instead and
            // let the phase-2 wrap-up resolve every tool_use (it already
            // re-fetches any stray list_github_issues).
            const hasTerminalTool = mayor1.toolUses.some((t) =>
              t.name === 'dispatch_claude_code'
              || t.name === 'dispatch_scout'
              || t.name === 'edit_spec'
              || t.name === 'write_spec');
            if (!issuesCalls.length || hasTerminalTool || issuesIters >= MAYOR_ISSUES_MAX_ITERS) break;
            issuesIters += 1;

            // Bill each intermediate data-tool turn — the Anthropic call
            // happened and is invoiced whether or not it produced text.
            // (The final iteration's spend is billed by the existing
            // phase-1 accounting just below the loop.)
            if (mayor1.usage) {
              const dataCost = llm.estimateCostCents(mayor1.usage, selectedModel);
              if (!userApiKey && dataCost) {
                await pool.query(
                  `INSERT INTO llm_usage (user_id, date, total_cost_cents) VALUES ($1, CURRENT_DATE, $2)
                   ON CONFLICT (user_id, date) DO UPDATE SET total_cost_cents = llm_usage.total_cost_cents + EXCLUDED.total_cost_cents`,
                  [req.user.id, dataCost]
                );
              }
              send('usage', { costCents: dataCost, model: selectedModel, byok: !!userApiKey });
            }

            await sendStatus("Reading the repo's open GitHub issues...");
            const issuesResults = await Promise.all(
              issuesCalls.map(() => resolveGithubIssuesToolResult(repoOwner, repoName))
            );
            mayorConvo = [
              ...mayorConvo,
              // Verbatim assistant content (incl. the tool_use blocks) so the
              // tool_result ids resolve, exactly like the phase-2 round-trip.
              { role: 'assistant', content: mayor1.rawContent },
              {
                role: 'user',
                content: issuesCalls.map((tc, i) => ({
                  type: 'tool_result',
                  tool_use_id: tc.id,
                  content: issuesResults[i],
                })),
              },
            ];
          }
        } catch (err) {
          if (stopHandle.stopped) {
            // User hit stop during phase-1. Mayor never got to finish a
            // response; nothing useful was persisted (the optimistic user
            // row was already committed above — that's fine, they can
            // edit/resend). Emit a clean `stopped` event so the client
            // tears down the streaming UI, and persist a system message
            // so the timeline reflects the stop on refresh.
            const byStr = stopHandle.stoppedBy ? ` by @${stopHandle.stoppedBy}` : '';
            await sendStatus(`Stopped${byStr}.`);
            send('stopped', { phase: 'mayor1', by: stopHandle.stoppedBy });
            send('done', {});
            res.end();
            if (stopRegistry.get(session.id) === stopHandle) stopRegistry.delete(session.id);
            setTimeout(() => sessionBus.clearSession(session.id), 30000);
            return;
          }
          throw err;
        }

        let mayorText1 = mayor1.text;
        log.info('sessions', 'Mayor phase-1 response', {
          sessionId: session.id,
          textLen: mayorText1.length,
          toolUses: mayor1.toolUses.length,
          stopReason: mayor1.stopReason,
          preview: mayorText1.substring(0, 200),
        });

        // Fallback text when the model jumps straight to a tool_use
        // with no preamble — the user otherwise stares at a silent
        // "Thinking…" until CC spins up, which looks broken.
        if (!mayorText1.trim() && mayor1.toolUses.length === 0) {
          mayorText1 = '_(Mayor returned no response — try sending again.)_';
          send('token', { text: mayorText1 });
        }

        // Defense in depth: if the Mayor wrote a fake "[CODING AGENT
        // COMPLETED]" marker into its plain-text reply WITHOUT actually
        // calling the tool, that's hallucinated output pretending a CC
        // run happened. Strip the bogus block, log a warn, and replace
        // it with a short note. The system prompt forbids this, but
        // models occasionally regress; without this check the user sees
        // a totally fabricated "fix summary" with no underlying commit.
        const fakeMarker = mayorText1.includes('[CODING AGENT COMPLETED]');
        const dispatched = mayor1.toolUses.some((t) => t.name === 'dispatch_claude_code');
        if (fakeMarker && !dispatched) {
          log.warn('sessions', 'Mayor wrote fake [CODING AGENT COMPLETED] without dispatching', {
            sessionId: session.id,
            preview: mayorText1.substring(0, 300),
          });
          mayorText1 = mayorText1
            .replace(/\[CODING AGENT COMPLETED\][\s\S]*$/i, '')
            .trim() || '(I described what should change, but didn\'t actually run the coding agent — try sending again.)';
        }

        // Always debit the Mayor's phase-1 spend — even on tool-only
        // turns where mayorText1 is empty (the Anthropic call still
        // happened and was billed). chat_session_messages still gets
        // an assistant row only when there's actual reasoning text;
        // an empty assistant message would clutter the chat history.
        const costCents1 = mayor1.usage ? llm.estimateCostCents(mayor1.usage, selectedModel) : 0;
        if (mayorText1.trim()) {
          send('mayor_reasoning', { text: mayorText1 });
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents)
             VALUES ($1, 'assistant', $2, $3, $4, $5)`,
            [session.id, mayorText1, selectedModel, mayor1.usage.input_tokens + mayor1.usage.output_tokens, costCents1]
          );
        }
        // BYOK users pay Anthropic directly, so we don't track their
        // spend in `llm_usage` (that table drives the admin-key daily
        // cap). The per-message cost_cents above + the SSE 'usage'
        // event still give them live visibility into what each turn
        // cost on their own key.
        if (mayor1.usage) {
          if (!userApiKey) {
            await pool.query(
              `INSERT INTO llm_usage (user_id, date, total_cost_cents) VALUES ($1, CURRENT_DATE, $2)
               ON CONFLICT (user_id, date) DO UPDATE SET total_cost_cents = llm_usage.total_cost_cents + EXCLUDED.total_cost_cents`,
              [req.user.id, costCents1]
            );
          }
          send('usage', { costCents: costCents1, model: selectedModel, byok: !!userApiKey });
        }

        // Pick which tool the Mayor invoked, with server-side priority
        // enforcement: edit_spec / write_spec / dispatch_scout >
        // dispatch_claude_code. If the Mayor (mis)used multiple in one
        // turn, we honor the planning tool and quietly drop the
        // dispatch — same rule the tool descriptions state, but
        // enforced here so a model regression can't cause a surprise
        // build mid-spec-discussion. edit_spec and write_spec are
        // mutually exclusive at the API surface (only one is exposed
        // per turn based on spec emptiness), but we check both just in
        // case a stale tool_use slips through.
        const editSpecCall = mayor1.toolUses.find((t) => t.name === 'edit_spec');
        const writeSpecCall = mayor1.toolUses.find((t) => t.name === 'write_spec');
        const scoutCall = mayor1.toolUses.find((t) => t.name === 'dispatch_scout');
        const dispatchCall = mayor1.toolUses.find((t) => t.name === 'dispatch_claude_code');

        let activeToolCall = null;
        let toolKind = null; // 'edit_spec' | 'write_spec' | 'scout' | 'build'
        if (editSpecCall) { activeToolCall = editSpecCall; toolKind = 'edit_spec'; }
        else if (writeSpecCall) { activeToolCall = writeSpecCall; toolKind = 'write_spec'; }
        else if (scoutCall) { activeToolCall = scoutCall; toolKind = 'scout'; }
        else if (dispatchCall) { activeToolCall = dispatchCall; toolKind = 'build'; }

        if (!activeToolCall) {
          // Pure chat turn — no tool call needed.
          send('done', {});
          res.end();
          setTimeout(() => sessionBus.clearSession(session.id), 30000);
          return;
        }

        // Race check: scout and build both share a per-session worker
        // container, so they share the same gate. write_spec and
        // edit_spec are just DB UPDATEs and bypass the gate entirely.
        //
        // Same warm-CC caveat as /status and isWorkerBusy above —
        // gating on container-status would reject every scout/build
        // for ~10 min after the first dispatch finishes (warm idle is
        // not busy).
        if (toolKind === 'scout' || toolKind === 'build') {
          if (activeWorkers.has(session.id) || worker.isInFlight(session.id)) {
            await sendStatus('Claude Code is already running for this session. Please wait for it to finish.');
            send('done', {});
            res.end();
            return;
          }
        }

        // Seal the phase-1 assistant bubble so the phase-2 wrap-up
        // lands in a fresh bubble below the CC status/progress events.
        send('assistant_message_end', {});

        // Persist any GitHub issues the Mayor declared this dispatch
        // addresses (#75). Union with the session's existing linkage so the
        // set grows across turns; pr-metadata.js turns each number into a
        // `Closes #N` line in the PR body. Only scout/build dispatches carry
        // this arg. Best-effort: a failure here must not block the build.
        if (toolKind === 'scout' || toolKind === 'build') {
          const declared = prMetadata.sanitizeIssueNumbers(activeToolCall.input?.addresses_issues);
          if (declared.length) {
            try {
              const { rows: liRows } = await pool.query(
                `SELECT linked_issues FROM chat_sessions WHERE id = $1`,
                [session.id]
              );
              const existing = prMetadata.sanitizeIssueNumbers(liRows[0] && liRows[0].linked_issues);
              const merged = prMetadata.sanitizeIssueNumbers([...existing, ...declared]);
              const changed = merged.length !== existing.length || merged.some((n, i) => n !== existing[i]);
              if (changed) {
                await pool.query(
                  `UPDATE chat_sessions SET linked_issues = $1 WHERE id = $2`,
                  [merged, session.id]
                );
                session.linked_issues = merged;
              }
            } catch (err) {
              log.warn('sessions', 'Failed to persist linked issues', { err: err.message, sessionId: session.id });
            }
          }
        }

        // --- Run the chosen tool ---
        let toolResult;
        if (toolKind === 'write_spec') {
          setPhase('spec');
          toolResult = await runWriteSpecTool({
            pool, session, send, sendStatus,
            toolInput: activeToolCall.input,
          });
        } else if (toolKind === 'edit_spec') {
          setPhase('spec');
          toolResult = await runEditSpecTool({
            pool, session, send, sendStatus,
            toolInput: activeToolCall.input,
          });
        } else if (toolKind === 'scout') {
          const toolPromptArg = typeof activeToolCall.input?.prompt === 'string' && activeToolCall.input.prompt.trim()
            ? activeToolCall.input.prompt.trim()
            : message.trim();

          setPhase('cc');
          toolResult = await runScoutTool({
            pool, config, req, res, session, selectedModel,
            userMessage: message.trim(),
            toolPromptArg,
            repoOwner, repoName,
            send, sendStatus,
            stopHandle,
            userApiKey,
          });

          if (stopHandle.stopped) {
            // Same shape as the build stop path: skip the Mayor wrap-up
            // because there's nothing coherent to summarize.
            send('stopped', { phase: 'cc', by: stopHandle.stoppedBy });
            send('done', {});
            res.end();
            if (stopRegistry.get(session.id) === stopHandle) stopRegistry.delete(session.id);
            setTimeout(() => sessionBus.clearSession(session.id), 30000);
            return;
          }
        } else {
          const toolPromptArg = typeof activeToolCall.input?.prompt === 'string' && activeToolCall.input.prompt.trim()
            ? activeToolCall.input.prompt.trim()
            : message.trim();

          setPhase('cc');
          toolResult = await runClaudeCodeTool({
            pool, config, req, res, session, selectedModel,
            userMessage: message.trim(),
            toolPromptArg,
            repoOwner, repoName,
            send, sendStatus,
            stopHandle,
            userApiKey,
          });

          if (stopHandle.stopped) {
            // User stopped during the CC run. The worker's finally already
            // tore it down; we skip the Mayor wrap-up entirely because the
            // Mayor has nothing coherent to summarize (no push, no PR, no
            // staging). The next dispatch resumes CC via --resume so its
            // own session memory is preserved.
            send('stopped', { phase: 'cc', by: stopHandle.stoppedBy });
            send('done', {});
            res.end();
            if (stopRegistry.get(session.id) === stopHandle) stopRegistry.delete(session.id);
            setTimeout(() => sessionBus.clearSession(session.id), 30000);
            return;
          }

          ccLog = toolResult.ccLog;
          stagingUrl = toolResult.stagingUrl;
        }

        // --- Phase 2: Mayor wrap-up turn ---
        //
        // Feed the tool_use → tool_result round-trip back into the model
        // so it can summarize what actually happened. `tool_choice: none`
        // prevents it from calling another tool (which would also hit
        // the `activeWorkers` race check or accidentally re-dispatch).
        //
        // Base on mayorConvo (not the original `messages`) so any
        // list_github_issues round-trips resolved above stay in context for
        // the wrap-up. Answer EVERY tool_use in the final assistant turn —
        // not just the terminal one we ran: if the Mayor combined a
        // list_github_issues call with a terminal tool (or hit the issues
        // loop cap), a leftover tool_use would otherwise dangle and Anthropic
        // would 400 the wrap-up. The terminal tool gets the real result; any
        // stray list_github_issues gets a fresh fetch; anything else gets a
        // benign skip note.
        const phase2ToolResults = [];
        for (const tu of mayor1.toolUses) {
          if (tu.id === activeToolCall.id) {
            phase2ToolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: toolResult.toolResultText,
              ...(toolResult.isError ? { is_error: true } : {}),
            });
          } else if (tu.name === 'list_github_issues') {
            phase2ToolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: await resolveGithubIssuesToolResult(repoOwner, repoName),
            });
          } else {
            phase2ToolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: 'Skipped — only one action runs per turn.',
              is_error: true,
            });
          }
        }
        const followUpMessages = [
          ...mayorConvo,
          // Anthropic requires the assistant turn to be the VERBATIM
          // content blocks we got back, including the tool_use block —
          // otherwise the tool_result's tool_use_id doesn't resolve.
          { role: 'assistant', content: mayor1.rawContent },
          { role: 'user', content: phase2ToolResults },
        ];

        // Phase-2 is intentionally NOT abortable — CC has already
        // pushed a commit, opened the PR, and rebuilt staging. Stopping
        // the summary now would just leave the user without context for
        // real-world changes that already exist. The client hides the
        // stop button and shows a plain spinner during this phase.
        setPhase('mayor2');
        // Re-read spec_md and rebuild the system prompt: scout,
        // write_spec, or edit_spec may have just mutated it, and the
        // wrap-up turn should describe the doc as it is now (not as it
        // was at the start of phase-1).
        currentSpec = await loadSessionSpec(pool, session.id);
        // Recompute PR context: a dispatch this turn may have just opened
        // a PR (applyPrMetadata mutates session.pr_number in place).
        const prContext2 = session.pr_number
          ? { prNumber: session.pr_number, prTitle: session.pr_title, status: session.status }
          : null;
        mayorPrompt = getMayorSystemPrompt(session.app_name, isWorkerBusy, currentSpec, !!session.app_self_hosted, prContext2);
        const mayor2 = await llm.streamChat({
          messages: followUpMessages,
          systemPrompt: mayorPrompt,
          model: selectedModel,
          tools,
          toolChoice: { type: 'none' },
          onToken: (text) => send('token', { text }),
          apiKey: userApiKey,
        });

        let mayorText2 = mayor2.text;
        log.info('sessions', 'Mayor phase-2 response', {
          sessionId: session.id,
          textLen: mayorText2.length,
          stopReason: mayor2.stopReason,
          preview: mayorText2.substring(0, 200),
        });
        if (!mayorText2.trim()) {
          // Cheap guard: we still want to show *something* after the
          // tool runs, even if the Mayor produces no wrap-up text.
          if (toolResult.isError) {
            mayorText2 = (toolKind === 'write_spec' || toolKind === 'edit_spec')
              ? "_The spec edit didn't go through — see the status above._"
              : toolKind === 'scout'
                ? "_The scout didn't finish successfully — see the status above._"
                : "_The coding agent didn't complete successfully — see the status messages above._";
          } else if (toolKind === 'write_spec' || toolKind === 'edit_spec' || toolKind === 'scout') {
            // Spec/scout just planned something — make the build handoff
            // explicit so a finished spec doesn't read as a finished change.
            mayorText2 = "_Spec updated — it's in the spec viewer. Tell me to build it whenever you're ready and I'll dispatch the coding agent._";
          } else {
            mayorText2 = '_Done._';
          }
          send('token', { text: mayorText2 });
        }
        send('mayor_reasoning', { text: mayorText2 });

        const costCents2 = llm.estimateCostCents(mayor2.usage, selectedModel);
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents)
           VALUES ($1, 'assistant', $2, $3, $4, $5)`,
          [session.id, mayorText2, selectedModel, mayor2.usage.input_tokens + mayor2.usage.output_tokens, costCents2]
        );
        if (!userApiKey) {
          await pool.query(
            `INSERT INTO llm_usage (user_id, date, total_cost_cents) VALUES ($1, CURRENT_DATE, $2)
             ON CONFLICT (user_id, date) DO UPDATE SET total_cost_cents = llm_usage.total_cost_cents + EXCLUDED.total_cost_cents`,
            [req.user.id, costCents2]
          );
        }
        send('usage', { costCents: costCents2, model: selectedModel, byok: !!userApiKey });
      } catch (err) {
        activeWorkers.delete(session.id);
        workerProgress.clear(session.id);
        log.error('sessions', 'Chat error', { message: err.message, stack: err.stack });
        send('error', { error: err.message });
      } finally {
        // Clear the stop handle for this session only if it's still the
        // one we registered (another turn may have replaced it if the
        // client somehow fired a second POST before this one finished).
        if (stopRegistry.get(session.id) === stopHandle) {
          stopRegistry.delete(session.id);
        }
      }

      send('done', {});
      res.end();
      // Drop the session-bus ring buffer shortly after completion.
      // Anything a reconnecting client might want to replay has either
      // already been delivered or is now persisted in the DB; keeping
      // the buffer longer just wastes memory on a dead run.
      setTimeout(() => sessionBus.clearSession(session.id), 30000);
    } catch (err) {
      log.error('sessions', 'Chat setup error', { message: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // ===== Spec stage endpoints =====
  //
  // The session has a working buffer (chat_sessions.spec_md, overwritten
  // by Mayor's write_spec / edit_spec / dispatch_scout) and an append-
  // only history of immutable numbered versions in chat_session_specs.
  // A version is frozen on every spec mutation (#27, via
  // snapshotSessionSpec), so spec_md is always byte-identical to the
  // latest version. Numbered versions (v1…vN) are the single spec
  // surface the dev-chat viewer presents (#69 removed the separate
  // "Draft (live)" entry and the manual "Save version" step); spec_md
  // is kept purely as the in-process anchor buffer for edit_spec and as
  // a theme signal for PR metadata. The dev-chat UI surfaces the spec
  // in a read-only side-panel viewer (see DevChat.specViewer in
  // public/js/dev-chat.js); the user ships it by asking the Mayor to
  // dispatch the coding agent in chat — there is no in-UI "Build from
  // spec" button.
  //
  // Read-only fetch returning the latest spec content (spec_md, == the
  // latest version) plus metadata for every past version so the dev-chat
  // can populate its version selector without a second round-trip; full
  // content of older versions comes from GET /specs/:version below.
  router.get('/api/sessions/:id/spec', async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.spec_md
         FROM chat_sessions cs
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [req.params.id, req.user.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Session not found' });

      const { rows: versions } = await pool.query(
        `SELECT version, built_at, commit_sha, pr_number, shared_to_group_at,
                LENGTH(content) AS char_count
         FROM chat_session_specs
         WHERE session_id = $1
         ORDER BY version DESC`,
        [req.params.id]
      );

      res.json({
        spec: sessionRows[0].spec_md || '',
        versions,
      });
    } catch (err) {
      log.error('sessions', 'Failed to get spec', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Fetch a frozen historical version verbatim. The spec viewer uses
  // this when the user picks an older version from the dropdown.
  // (User hand-edits via PUT /spec were dropped — the Mayor /
  // dispatch_scout writes the live draft and the user only ever views
  // the result. Old sessions that already have frozen versions in
  // chat_session_specs keep their browseable history through this
  // endpoint and the share endpoint below.)
  //
  // Access rule:
  //   - Owner of the originating session: every version (saved drafts
  //     are private until explicitly shared).
  //   - Anyone else (any authed user): only versions where
  //     shared_to_group_at IS NOT NULL — i.e. the spec was explicitly
  //     posted into the app's group chat via /specs/:version/share.
  //     The group-chat read endpoint has no membership gate, so once
  //     a spec is shared every logged-in user can already see the
  //     share card; the body of the spec should be reachable too,
  //     otherwise the "View full spec" affordance on the card 404s
  //     for everyone except the original sharer (#6).
  router.get('/api/sessions/:id/specs/:version', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const version = parseInt(req.params.version, 10);
    if (Number.isNaN(sessionId) || Number.isNaN(version)) {
      return res.status(400).json({ error: 'Bad id/version' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT s.version, s.content, s.built_at, s.commit_sha, s.pr_number, s.shared_to_group_at
         FROM chat_session_specs s
         JOIN chat_sessions cs ON cs.id = s.session_id
         WHERE s.session_id = $1
           AND s.version = $2
           AND (cs.user_id = $3 OR s.shared_to_group_at IS NOT NULL)`,
        [sessionId, version, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Spec version not found' });
      res.json({ spec: rows[0] });
    } catch (err) {
      log.error('sessions', 'Failed to get spec version', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // (#69) The manual POST /api/sessions/:id/specs "Save version" route
  // was retired. Every Mayor spec mutation (write_spec / edit_spec /
  // scout) already auto-freezes an immutable numbered version via
  // snapshotSessionSpec(), so the live spec_md is always byte-identical
  // to the latest chat_session_specs row. The old route just re-snapped
  // that same content and almost always hit its own dedup branch — a
  // no-op. snapshotSessionSpec() is now the sole writer of new versions;
  // the dev-chat spec viewer shares any numbered version directly with
  // no save step in between.

  // Share a frozen spec snapshot into the app's group chat. The group
  // chat renders the message as a "spec card" with a snippet + view-
  // full-spec affordance; the underlying chat_messages row carries
  // metadata.specShare so the renderer knows to upgrade it from a
  // plain system line.
  router.post('/api/sessions/:id/specs/:version/share', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const version = parseInt(req.params.version, 10);
    if (Number.isNaN(sessionId) || Number.isNaN(version)) {
      return res.status(400).json({ error: 'Bad id/version' });
    }

    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.app_id, a.slug as app_slug
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [sessionId, req.user.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Session not found' });
      const { app_id: appId, app_slug: appSlug } = sessionRows[0];

      const { rows: specRows } = await pool.query(
        `SELECT version, content, built_at, commit_sha, pr_number
         FROM chat_session_specs
         WHERE session_id = $1 AND version = $2`,
        [sessionId, version]
      );
      if (!specRows.length) return res.status(404).json({ error: 'Spec version not found' });
      const spec = specRows[0];

      // Title + snippet for the card. The title is the first H1
      // (`# Heading`) in the spec, used as the card's primary heading
      // so users see what the spec is *about* instead of just "v3".
      // The snippet is the body content with the title line stripped
      // (otherwise it'd appear twice — once in the card header, once
      // at the top of the snippet body). Old shares predate this
      // payload shape and have no title; the renderer falls back to
      // "Spec vN" in that case.
      const title = extractSpecTitle(spec.content);
      const snippet = extractSpecSnippet(spec.content, title);

      const shareMeta = {
        specShare: {
          sessionId,
          version: spec.version,
          builtAt: spec.built_at,
          commitSha: spec.commit_sha || null,
          prNumber: spec.pr_number || null,
          title,
          snippet,
          totalChars: (spec.content || '').length,
          sharedBy: { id: req.user.id, username: req.user.username },
        },
      };
      const summaryLine = title
        ? `📋 ${req.user.username || 'Someone'} shared "${title}" (spec v${spec.version}).`
        : `📋 ${req.user.username || 'Someone'} shared spec v${spec.version} from a dev session.`;

      const { rows: msgRows } = await pool.query(
        `INSERT INTO chat_messages (app_id, user_id, content, msg_type, metadata)
         VALUES ($1, $2, $3, 'spec_share', $4)
         RETURNING id, created_at`,
        [appId, req.user.id, summaryLine, JSON.stringify(shareMeta)]
      );

      await pool.query(
        `UPDATE chat_session_specs SET shared_to_group_at = NOW()
         WHERE session_id = $1 AND version = $2 AND shared_to_group_at IS NULL`,
        [sessionId, version]
      );

      // Broadcast to room subscribers using the same envelope the WS
      // group-chat handler emits, so the existing renderMessageHtml
      // path picks it up. We also fan out the metadata so the card has
      // everything it needs without a follow-up fetch.
      const { broadcast } = require('../services/ws');
      broadcast(appId, {
        type: 'chat',
        id: msgRows[0].id,
        userId: req.user.id,
        username: req.user.username,
        content: summaryLine,
        msgType: 'spec_share',
        metadata: shareMeta,
        createdAt: msgRows[0].created_at,
      });

      res.json({ ok: true, appSlug, messageId: msgRows[0].id });
    } catch (err) {
      log.error('sessions', 'Share spec failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Check if a session has an active worker + get latest progress
  router.get('/api/sessions/:id/status', async (req, res) => {
    const sessionId = parseInt(req.params.id);
    // "busy" = a CC/scout dispatch is actively running for this
    // session right now. We deliberately do NOT key on
    // `containerStatus === 'running'` here — since the warm-CC commit
    // (eb62570 "keep cc warm between calls") the worker container
    // stays running between dispatches, so a running container only
    // means "the wrapper is sleep-looping", not "claude is busy".
    // Using container-status as the busy signal would strand the
    // dev-chat polling fallback in `busy: true` for the full ~10-min
    // idle-eviction window whenever the POST SSE drops before
    // delivering `done`.
    //
    // `activeWorkers` covers the in-flight window from the chat
    // handler's POV (added before ensureWorker, deleted in
    // run(Scout|ClaudeCode)Tool's finally). `worker.isInFlight`
    // covers the inner exec window (set by execInWorker around the
    // actual `docker exec`) — redundant in normal flow, but a useful
    // safety net for adopted workers and the brief period between
    // adding to activeWorkers and registering with the warm registry.
    const busy = activeWorkers.has(sessionId) || worker.isInFlight(sessionId);

    let progress = [];
    try {
      const { rows } = await pool.query(
        `SELECT metadata FROM chat_session_messages
         WHERE session_id = $1 AND role = 'system' AND metadata->>'progressLog' IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [sessionId]
      );
      if (rows[0]?.metadata?.progressLog) {
        progress = rows[0].metadata.progressLog;
      }
    } catch {}

    // Current turn phase (mayor1 / cc / mayor2). Lets the client pick
    // between the stop button and the finishing-up spinner on refresh
    // without guessing from container status alone.
    const phase = stopRegistry.get(sessionId)?.phase || null;

    res.json({ busy, progress, phase });
  });

  // Stop an in-flight turn (#28). Aborts the Mayor's Anthropic stream
  // during phase-1 and/or `docker stop`s the Claude Code worker during
  // the CC phase. Deliberately does NOT abort Mayor phase-2 — by then
  // the commit + PR + staging already exist, and stopping the summary
  // would leave the user without context for changes that are real.
  router.post('/api/sessions/:id/stop', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    if (Number.isNaN(sessionId)) return res.status(400).json({ error: 'Bad session id' });

    try {
      const { rows } = await pool.query(
        `SELECT id FROM chat_sessions WHERE id = $1 AND user_id = $2`,
        [sessionId, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
    } catch (err) {
      log.error('sessions', 'Stop session lookup failed', { message: err.message });
      return res.status(500).json({ error: 'Internal server error' });
    }

    const handle = stopRegistry.get(sessionId);
    if (!handle) {
      return res.json({ ok: true, stopped: false, reason: 'no active turn' });
    }
    if (handle.phase === 'mayor2') {
      // Phase-2 is non-stoppable on purpose. The UI already swaps the
      // stop button for a spinner during this phase, so this branch is
      // mostly defense against an out-of-date client.
      return res.json({ ok: true, stopped: false, reason: 'wrap-up cannot be stopped' });
    }

    handle.stopped = true;
    handle.stoppedBy = req.user.username;
    log.info('sessions', 'Stop requested', {
      sessionId,
      phase: handle.phase,
      by: req.user.username,
      hasExec: !!handle.execChild,
      hasWorker: !!handle.workerName,
    });

    if (handle.execChild) {
      // Long-lived worker path: SIGTERM the host-side `docker exec`
      // child. Docker forwards the signal into the in-container
      // run-cc.sh + claude processes, which exit; the warm wrapper
      // (sleep infinity) keeps running so the next dispatch is fast.
      // The host-side execInWorker promise resolves when the child
      // closes, letting runClaudeCodeTool's early-return branch fire.
      try { handle.execChild.kill('SIGTERM'); } catch {}
    } else if (handle.workerName) {
      // Legacy single-shot fallback: no exec child to signal, so we
      // SIGTERM the whole container. `docker stop` gives it ~10s
      // before SIGKILL — fine for the legacy path because the wrapper
      // IS the per-turn workload there.
      docker.execFileAsync('docker', ['stop', handle.workerName], { timeout: 15000 })
        .catch((err) => log.warn('sessions', 'docker stop failed', { err: err.message }));
    }

    try { handle.abort.abort(); } catch {}

    res.json({ ok: true, stopped: true, phase: handle.phase });
  });

  // Resumable SSE subscription for a single session's event stream.
  // Intended as a reconnect channel when the primary POST /chat SSE
  // response drops mid-run: the client opens an EventSource here, and
  // EventSource's built-in retry + Last-Event-Id gives us exactly-once
  // delivery (relative to the bus's ring buffer) without us having to
  // reinvent reconnection logic.
  //
  // The client may also pass `?since=<seq>` explicitly on the first
  // connect to replay from a specific point (e.g. the last _seq it saw
  // on the POST stream before it died).
  router.get('/api/sessions/:id/events', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    if (!sessionId) return res.status(400).end();

    // Scope to sessions the caller can see. Admins should see everything
    // (same as elsewhere in this file) but regular users only their own.
    try {
      const { rows } = await pool.query(
        `SELECT user_id FROM chat_sessions WHERE id = $1`,
        [sessionId]
      );
      if (!rows.length) return res.status(404).end();
      if (!req.user?.is_admin && rows[0].user_id !== req.user?.id) {
        return res.status(403).end();
      }
    } catch {
      return res.status(500).end();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Nudge intermediaries (Caddy/Nginx/etc.) to flush right away so the
    // browser's EventSource transitions to OPEN without waiting for the
    // first real event.
    try { res.write(`:ok\n\n`); } catch {}

    // Prefer the header (what EventSource sends automatically on retry)
    // but fall back to an explicit query arg for the first connect.
    const sinceSeq = req.headers['last-event-id'] || req.query.since || null;

    const write = (event) => {
      try {
        // `id:` makes EventSource remember this _seq and echo it back as
        // Last-Event-Id on reconnect, driving the ring-buffer replay.
        res.write(`id: ${event._seq}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {}
    };

    const unsubscribe = sessionBus.subscribe(sessionId, write, sinceSeq);

    // Keep idle proxies/load balancers from dropping the connection.
    const hb = setInterval(() => {
      try { res.write(`:heartbeat\n\n`); } catch {}
    }, 15000);

    const close = () => {
      clearInterval(hb);
      try { unsubscribe(); } catch {}
    };
    req.on('close', close);
    req.on('error', close);
  });

  // Get current user's budget
  router.get('/api/budget', async (req, res) => {
    try {
      const userLimit = await limits.getEffectiveUserLimitCents(pool, req.user.id);
      const globalLimit = await limits.getGlobalLimitCents(pool);
      const budget = await checkBudget(pool, req.user.id);
      const userSpent = budget.error ? userLimit : userLimit - (budget.userRemaining || 0);
      const globalSpent = budget.error ? globalLimit : globalLimit - (budget.globalRemaining || 0);
      res.json({
        spentCents: userSpent,
        limitCents: userLimit,
        globalSpentCents: globalSpent,
        globalLimitCents: globalLimit,
      });
    } catch (err) {
      log.error('sessions', 'Budget check failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Deploy staging for a session
  router.post('/api/sessions/:id/deploy-staging', drainGuard, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url, a.id as app_id_val
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status IN ('active', 'promoted')`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found' });
      const session = rows[0];
      const app = { id: session.app_id_val, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };

      // Get latest commit hash from the branch
      let commitHash = 'latest';
      if (github.isEnabled() && app.repo_url) {
        try {
          const [, owner, repo] = app.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
          if (owner && repo) {
            // octokit.request, not .rest.git.getRef — @octokit/app's
            // installation Octokit lacks the rest-endpoint-methods
            // plugin. {+ref} preserves the `/` in `heads/<branch>`;
            // plain {ref} would percent-encode it and 404.
            const octokit = await github.getInstallationOctokit(owner);
            const { data: ref } = await octokit.request(
              'GET /repos/{owner}/{repo}/git/ref/{+ref}',
              { owner, repo, ref: `heads/${session.branch_name}` }
            );
            commitHash = ref.object.sha;
          }
        } catch {}
      }

      // Build and deploy staging (async — respond immediately)
      res.json({ ok: true, status: 'deploying' });

      staging.buildAndDeployStaging(config, session, app, commitHash)
        .then(async (result) => {
          await pool.query(
            `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
            [result.containerId, result.stagingUrl, session.id]
          );
          // Warm the cert only after staging_url is persisted (Caddy's `ask`
          // gate keys off it); otherwise the warm is refused and the first
          // click hits a cold hostname.
          await staging.warmStagingCert(session, result.hostname, result.stagingUrl);
        })
        .catch((err) => {
          log.error('sessions', 'Staging deploy failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('sessions', 'Deploy staging error', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// Thin alias so existing in-file callers keep working unchanged.
// New callers (conflict-resolver, etc.) should `require('../services/limits')`
// directly and call `limits.checkBudget(pool, userId)`.
async function checkBudget(pool, userId) {
  return limits.checkBudget(pool, userId);
}

// Tools the Mayor can call. Each user message produces at most one
// tool_use (we serialize per-session to one CC dispatch at a time). The
// Mayor's system prompt teaches the priority order between these.
//
// Build the app for real: clones the repo, edits files, commits, and
// pushes to the dev branch. Staging auto-rebuilds. This is the
// expensive path — a Docker container per call.
const DISPATCH_TOOL = {
  name: 'dispatch_claude_code',
  description:
    'Dispatch an autonomous coding agent (Claude Code) to make the requested changes to the app repo. '
    + 'The agent will clone the repo, edit files, commit, and push to the dev branch — staging will auto-rebuild. '
    + 'Use ONLY when the user has asked for a concrete, actionable code change. Do not call when the user is '
    + 'just chatting, brainstorming, asking about past work, or giving vague feedback. At most one call per user message. '
    + 'NOTE: the current spec doc (CURRENT SPEC DOC in your context) is auto-injected into the agent\'s prompt — '
    + 'do NOT re-summarize the spec in the prompt arg; describe only WHICH SLICE to build now.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'A clear, self-contained description of what the coding agent should build or fix RIGHT NOW. '
          + 'The session\'s spec doc is auto-injected into the agent\'s context — do NOT restate the spec here. '
          + 'Instead, describe which slice of the spec (or which user request, if no spec exists) to implement '
          + 'in this dispatch: what to change, where, and the expected user-visible behavior. '
          + 'Do NOT include code. Roughly 1-4 sentences.',
      },
      addresses_issues: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'OPTIONAL. The numbers of OPEN GitHub issues this dispatch concretely fixes or implements. '
          + 'Populate ONLY with issues you have actually seen via list_github_issues AND have deliberately '
          + "decided this work resolves — never guess, never auto-match by keyword, and omit it entirely for "
          + 'tangentially-related issues. Each number listed becomes a `Closes #N` line in the PR body, so the '
          + 'issue auto-closes when the PR merges. Numbers accumulate across turns; pass only the ones newly relevant.',
      },
    },
    required: ['prompt'],
  },
};

// Spec stage — read-only investigation. Runs CC in --permission-mode
// plan: it reads files, but cannot edit/commit/push. Output is captured
// as the session's spec_md doc, which the user can then review in the
// dev-chat spec viewer side-panel. Slow (~30-60s container spinup) but
// authoritative — it's the only way for the Mayor to ground a spec in
// real file evidence rather than guess.
const DISPATCH_SCOUT_TOOL = {
  name: 'dispatch_scout',
  description:
    'Dispatch the coding agent in read-only PLAN MODE to investigate the repo and draft a grounded markdown spec. '
    + 'Use for the FIRST substantive spec work in a session, when you need to know what files exist or how things are currently built. '
    + "The agent reads files and writes prose; it CANNOT edit, commit, or push. Output replaces the session's spec doc. "
    + 'Slow (~30-60s) — do not call for small revisions; use edit_spec (or write_spec when the spec is empty) instead. At most one call per user message.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Instructions for the scout. Should describe what to investigate and what shape the resulting spec should take '
          + '(e.g. "Read the relevant files for the leaderboard and draft a markdown spec covering screens, data model, '
          + 'and edge cases for adding realtime updates"). 1-3 sentences.',
      },
      addresses_issues: {
        type: 'array',
        items: { type: 'integer' },
        description:
          'OPTIONAL. The numbers of OPEN GitHub issues this work concretely addresses. '
          + 'Populate ONLY with issues you have actually seen via list_github_issues AND have deliberately '
          + "decided this work resolves — never guess, never auto-match by keyword, and omit it for tangential issues. "
          + 'Each number becomes a `Closes #N` line in the PR body so the issue auto-closes on merge. '
          + 'Numbers accumulate across turns; pass only the ones newly relevant.',
      },
    },
    required: ['prompt'],
  },
};

// Spec stage — cheap, in-process spec edit. No container, no model
// round-trip beyond the Mayor's own turn. Used for the FIRST draft
// when scout would be overkill; once a spec exists, the Mayor uses
// edit_spec instead (see EDIT_SPEC_TOOL below). Forbidden to combine
// with dispatch_claude_code in the same turn — the user owns the
// dispatch decision and asks the Mayor to do it in chat.
const WRITE_SPEC_TOOL = {
  name: 'write_spec',
  description:
    'Overwrite the current draft spec for this session with the given markdown content. '
    + 'Only available when the spec is currently empty — once a spec exists, this tool is replaced by edit_spec. '
    + 'Use this to capture an INITIAL spec when scout would be overkill (e.g. the user gave you a clear, self-contained design). '
    + 'Cannot read the repo; if you need real file evidence, use dispatch_scout first. '
    + 'Do not call dispatch_claude_code in the same turn as write_spec.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'The full new contents of the spec doc. Markdown formatted; pick sections that fit the task '
          + '(Goal, Screens, Data Model, Edge Cases, etc.). Prefer decisions over questions: only add a '
          + '"Questions" section for items that genuinely block implementation; put non-blocking notes '
          + 'under "Considerations" or "Deferred work" instead. '
          + 'Pass RAW markdown — do NOT wrap the whole spec in a code fence (no leading ```markdown / trailing ```), '
          + 'or it renders as one big code block. '
          + 'The spec renders as standard CommonMark: if a fenced code block must itself contain a '
          + 'triple-backtick fence, wrap the outer block in a four-backtick fence so the inner fence does '
          + 'not close it early and break the rest of the doc.',
      },
    },
    required: ['content'],
  },
};

// Spec stage — anchored, in-process spec edit. Replaces write_spec
// once a spec exists, so revisions splice into the existing doc rather
// than overwriting it from scratch. The model sees the current spec
// verbatim in its system prompt (CURRENT SPEC DOC block) so it can
// quote old_text exactly. On miss/ambiguous-match the call returns a
// recoverable error and the user can re-prompt.
const EDIT_SPEC_TOOL = {
  name: 'edit_spec',
  description:
    'Edit the current spec by replacing an exact existing snippet with new content. '
    + 'Use for ALL revisions once a spec exists. Anchored: old_text MUST match a unique '
    + 'verbatim substring of the current spec (whitespace included). new_text replaces '
    + 'that match; pass empty new_text to delete a section, or include old_text inside new_text '
    + 'to insert nearby content. Cannot overwrite the whole doc; for heavy restructures, make '
    + 'multiple edit_spec calls across turns. '
    + 'Cannot read the repo; if you need real file evidence, use dispatch_scout first. '
    + 'Do not call dispatch_claude_code in the same turn as edit_spec.',
  input_schema: {
    type: 'object',
    properties: {
      old_text: {
        type: 'string',
        description:
          'Exact verbatim substring from the current spec to replace. Must occur exactly once. '
          + 'Copy directly from the CURRENT SPEC DOC block in your system prompt; include 1–2 '
          + 'surrounding lines if needed for uniqueness.',
      },
      new_text: {
        type: 'string',
        description:
          'Replacement content. Empty string deletes the matched section. '
          + 'To add new content next to an existing section, include the original old_text inside new_text. '
          + 'Markdown rendered as standard CommonMark: if new_text adds a fenced code block that itself '
          + 'contains a triple-backtick fence, wrap the outer block in a four-backtick fence so it does not '
          + 'close early.',
      },
    },
    required: ['old_text', 'new_text'],
  },
};

// Read-only data tool. Unlike the dispatch/spec tools (which are terminal
// actions), this just FETCHES the repo's open GitHub issues and feeds them
// back so the Mayor can reason with them in the same turn. Available on
// every Mayor turn (even while a worker is busy — it's cheap and read-only).
// Scout + build reach the identical capability via the worker's
// usernode-issues CLI; nothing about issues is injected into any prompt.
const LIST_GITHUB_ISSUES_TOOL = {
  name: 'list_github_issues',
  description:
    "List the OPEN GitHub issues on this app's repository (read-only). "
    + 'Returns JSON `{ issues: [{ number, title, body, labels, updatedAt, htmlUrl }], truncatedList }` — '
    + 'pull requests are excluded and long bodies are truncated. '
    + 'Call this when the user mentions the issue tracker, asks what issues or bugs are filed, '
    + 'or when planning work that may already be reported, so your reply is grounded in real issues. '
    + 'It only READS issues — it cannot create, comment on, edit, or close them. Takes no input.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

// Cap on how many consecutive list_github_issues fetches we'll service
// within a single Mayor turn before forcing the model to move on. Bounds
// the worst case where the model loops on the data tool instead of acting.
const MAYOR_ISSUES_MAX_ITERS = 3;

// Resolve a list_github_issues tool call to the JSON string we hand back as
// tool_result content. Owner/repo come straight from apps.repo_url; when
// they're absent we return the well-formed empty-with-note shape rather
// than erroring. github.fetchPublicIssues never throws.
async function resolveGithubIssuesToolResult(repoOwner, repoName) {
  if (!repoOwner || !repoName) {
    return JSON.stringify({ issues: [], truncatedList: false, note: 'no repo' });
  }
  const result = await github.fetchPublicIssues(repoOwner, repoName);
  return JSON.stringify(result);
}

// Build the Mayor's message history from chat_session_messages rows.
// Folds each CC output (persisted as a system row with metadata.ccOutput)
// into the preceding assistant turn with a [CODING AGENT COMPLETED] tag
// so the Mayor knows what got built previously without us having to feed
// it as a synthetic user message. Merges consecutive assistant rows
// (which now happen routinely — phase-1 plan + phase-2 summary per
// tool-use turn) so Anthropic's alternating-roles contract is preserved.
// Short, human-readable label for a Claude model id. Used in
// user-facing status lines (e.g. "Spinning up coding agent (Opus
// 4.6)..."). Falls back to the raw id so unknown/new model slugs at
// least show something identifiable rather than a blank parenthetical.
function prettyModelLabel(modelId) {
  if (!modelId) return 'Sonnet';
  if (modelId.includes('opus')) return 'Opus';
  if (modelId.includes('haiku')) return 'Haiku';
  if (modelId.includes('sonnet')) return 'Sonnet';
  return modelId;
}

function buildMayorMessages(history) {
  const CC_SUMMARY_MAX = 2000;
  const messages = [];
  const pushAssistant = (text) => {
    if (messages.length && messages[messages.length - 1].role === 'assistant') {
      messages[messages.length - 1].content += `\n\n${text}`;
    } else {
      messages.push({ role: 'assistant', content: text });
    }
  };
  for (const row of history) {
    if (row.role === 'system' && row.metadata?.ccOutput) {
      const summary = String(row.metadata.ccOutput).slice(0, CC_SUMMARY_MAX);
      pushAssistant(`[CODING AGENT COMPLETED]:\n${summary}`);
    } else if (row.role === 'assistant') {
      pushAssistant(row.content);
    } else if (row.role === 'user') {
      messages.push({ role: 'user', content: row.content });
    }
  }
  return messages;
}

// Cheap, in-process spec edit triggered by the Mayor's write_spec tool.
// No worker container, no model round-trip beyond the Mayor's own turn —
// we just UPDATE chat_sessions.spec_md, fire a system status event so
// the dev-chat timeline shows the change, and emit `spec_updated` so any
// open Spec panel re-renders live. Returns a tool_result summary the
// phase-2 wrap-up will narrate to the user.
async function runWriteSpecTool({ pool, session, send, sendStatus, toolInput }) {
  const content = stripSpecWrapperFence(typeof toolInput?.content === 'string' ? toolInput.content : '');
  if (!content.trim()) {
    await sendStatus('write_spec was called with empty content; the spec was not updated.');
    return {
      toolResultText: 'write_spec was called without content. The spec doc is unchanged.',
      isError: true,
    };
  }

  await pool.query(
    'UPDATE chat_sessions SET spec_md = $1 WHERE id = $2',
    [content, session.id]
  );

  const lineCount = content.split('\n').length;
  const charCount = content.length;
  const preview = buildSpecPreview(content);

  // #27: freeze this draft so the inline card opens its own content.
  const specVersion = await snapshotSessionSpec(pool, session.id, content);

  await sendStatus(
    `Spec updated (${lineCount} lines).`,
    { specPreview: preview, specLines: lineCount, specVersion }
  );
  send('spec_updated', { length: charCount, lines: lineCount, version: specVersion });

  return {
    toolResultText:
      `The session's spec doc was overwritten with new content (${lineCount} lines, ${charCount} chars). `
      + `The user can review it in the dev-chat spec viewer. When they're ready to ship, they'll ask you to dispatch the coding agent.`,
    isError: false,
  };
}

// Anchored, in-process spec edit triggered by the Mayor's edit_spec
// tool. Re-reads spec_md from the DB (don't trust Mayor-side staleness)
// and validates that old_text appears exactly once. On miss/ambiguous
// match we return a recoverable error so the Mayor can retry on the
// next user message — explicitly NOT a silent regenerate-from-scratch.
// Same status/spec_updated event shape as runWriteSpecTool so the
// dev-chat timeline + Spec panel update identically.
async function runEditSpecTool({ pool, session, send, sendStatus, toolInput }) {
  const oldText = typeof toolInput?.old_text === 'string' ? toolInput.old_text : '';
  const newText = typeof toolInput?.new_text === 'string' ? toolInput.new_text : '';

  if (!oldText) {
    await sendStatus('edit_spec was called with empty old_text; the spec was not updated.');
    return {
      toolResultText:
        'edit_spec was called with empty old_text. Nothing to anchor against. '
        + 'The spec doc is unchanged.',
      isError: true,
    };
  }

  const currentSpec = await loadSessionSpec(pool, session.id);

  if (!currentSpec.trim()) {
    await sendStatus('edit_spec was called but the spec is empty; use write_spec to draft an initial spec.');
    return {
      toolResultText:
        'edit_spec was called but the current spec is empty — there is nothing to edit. '
        + 'The spec doc is unchanged. Use write_spec to draft an initial spec, or dispatch_scout to investigate the repo first.',
      isError: true,
    };
  }

  // Count occurrences without regex (avoids escape pain on markdown
  // text). Fail loudly on miss or ambiguity rather than silently
  // mutating something the Mayor didn't intend.
  let occurrences = 0;
  let idx = 0;
  while (true) {
    const found = currentSpec.indexOf(oldText, idx);
    if (found === -1) break;
    occurrences += 1;
    if (occurrences > 1) break;
    idx = found + oldText.length;
  }

  if (occurrences === 0) {
    await sendStatus('edit_spec failed: old_text not found in the current spec.');
    return {
      toolResultText:
        'edit_spec failed: old_text was not found in the current spec. '
        + 'The current spec is shown verbatim in the CURRENT SPEC DOC block of your system prompt — '
        + 'copy old_text directly from there (whitespace included). '
        + 'The spec doc is unchanged.',
      isError: true,
    };
  }

  if (occurrences > 1) {
    await sendStatus('edit_spec failed: old_text matched multiple places in the spec.');
    return {
      toolResultText:
        `edit_spec failed: old_text matched ${occurrences > 1 ? '2 or more' : occurrences} places in the current spec. `
        + 'Make the snippet unique by including more surrounding context (an extra line above and below is usually enough). '
        + 'The spec doc is unchanged.',
      isError: true,
    };
  }

  const matchIdx = currentSpec.indexOf(oldText);
  const updated = stripSpecWrapperFence(
    currentSpec.slice(0, matchIdx) + newText + currentSpec.slice(matchIdx + oldText.length)
  );

  await pool.query(
    'UPDATE chat_sessions SET spec_md = $1 WHERE id = $2',
    [updated, session.id]
  );

  const beforeLines = currentSpec.split('\n').length;
  const afterLines = updated.split('\n').length;
  const removedLines = oldText.split('\n').length;
  const addedLines = newText.split('\n').length;
  const lineDelta = afterLines - beforeLines;
  const preview = buildSpecPreview(updated);

  // #27: freeze this edited spec so the inline card opens its own content.
  const specVersion = await snapshotSessionSpec(pool, session.id, updated);

  await sendStatus(
    `Spec edited (−${removedLines} / +${addedLines} lines, now ${afterLines} total).`,
    { specPreview: preview, specLines: afterLines, specVersion }
  );
  send('spec_updated', { length: updated.length, lines: afterLines, version: specVersion });

  return {
    toolResultText:
      `The session's spec doc was edited in place: the matched ${oldText.length}-char snippet was replaced with `
      + `a ${newText.length}-char snippet (−${removedLines} / +${addedLines} lines, net ${lineDelta >= 0 ? '+' : ''}${lineDelta}; spec is now ${afterLines} lines total). `
      + `The user can review it in the dev-chat spec viewer. When they're ready to ship, they'll ask you to dispatch the coding agent.`,
    isError: false,
  };
}

// Runs Claude Code in read-only PLAN MODE (the spec-stage scout). CC
// reads the repo and produces a markdown spec as its final result text;
// we capture that into chat_sessions.spec_md. No commit, no push, no
// staging rebuild — by design, scout is structurally forbidden from
// editing anything. Mirrors runClaudeCodeTool's stop / progress / cost-
// tracking shape so the existing client SSE handlers don't have to
// special-case scout vs. build.
async function runScoutTool({
  pool, config, req, res, session, selectedModel,
  userMessage, toolPromptArg,
  repoOwner, repoName,
  send, sendStatus,
  stopHandle,
  userApiKey,
}) {
  activeWorkers.add(session.id);
  const modelLabel = prettyModelLabel(selectedModel);
  await sendStatus(`Scouting the repo for context (${modelLabel})...`);

  await worker.ensureWorkerImage();

  // Scout-specific prompt. Deliberately omits the platform-conventions
  // block and commit/push instructions used in the build prompt — scout
  // never edits anything. The "final message is the spec" contract is
  // load-bearing: we extract `result.lastResultText` verbatim and store
  // it as spec_md, so any preamble would leak into the user's spec.
  const scoutPrompt = `SCOUT TASK (from the Mayor):
${toolPromptArg}

USER REQUEST: "${userMessage}"

You are running in PLAN MODE: you can read files (Read, Glob, Grep) but you cannot edit, commit, or push anything. Do not attempt to.

A read-only helper \`usernode-issues\` is available (run it via Bash) — it prints the repo's open GitHub issues as JSON (\`{ issues: [{ number, title, body, labels, updatedAt, htmlUrl }], truncatedList }\`). Use it if the open issues are relevant context for this spec; do not try to reach GitHub any other way.

Your job is to investigate this repo and produce a MARKDOWN SPEC for the change. The spec should be:
- A complete, self-contained markdown document the user can review on its own.
- Grounded in real file evidence — reference actual file paths and current behaviour, not guesses.
- Structured with sensible headings (e.g. Goal, Affected Screens, Data Model, Edge Cases). Pick whatever sections fit the task; one size does not fit all.
- Specific enough that a coding agent could implement it without re-doing your investigation, but NOT a literal diff or code block.

The spec is rendered as markdown in a viewer that follows standard CommonMark fencing. If you include a fenced code block that ITSELF contains a triple-backtick fence (common when quoting markdown examples or the platform's \`\`\`filepath:...\`\`\` output convention), wrap the OUTER block in a four-backtick fence (\`\`\`\`) — a longer fence can safely contain shorter ones. Otherwise the inner \`\`\` closes the block early and the rest of the spec renders broken. When in doubt, prefer fewer/inline code samples over deeply nested fences.

Do NOT pad the spec with open questions. Only include a "Questions" section for things that genuinely BLOCK implementation — decisions the coding agent cannot reasonably make on its own and that would change what gets built. Make a sensible default choice wherever you can and state it, rather than asking. Non-blocking items — things worth noting but not required to answer before building — belong under "Considerations" (trade-offs, assumptions, things to keep in mind) or "Deferred work" (out-of-scope or follow-up items), NOT as questions.

Your final assistant message must be ONLY the markdown spec — no preamble, no "I'll investigate...", no "Here's the spec:". The host captures that final message verbatim and stores it as the session's spec doc.

CRITICAL: Output the spec as RAW markdown. Do NOT wrap your whole response in a code fence — no leading \`\`\`markdown line and no trailing \`\`\`. A whole-document fence makes the spec render as one big code block instead of formatted markdown. Fences are only for actual code/quoted snippets INSIDE the spec.`;

  // Ensure the long-lived worker is warm before exec'ing run-cc.sh inside
  // it. Cold-start cost (clone + checkout + sleep wrapper) is paid here on
  // the first dispatch of a session; subsequent ensures are sub-second.
  // Bootstrap progress (clone/checkout/warm-ready) flows through onProgress
  // to the dev-chat UI just like the legacy single-shot path used to.
  const containerName = await worker.ensureWorker(session.id, {
    repoOwner,
    repoName,
    branchName: session.branch_name,
    anthropicApiKey: userApiKey || null,
    onProgress: (text) => {
      send('cc_progress', { text });
      workerProgress.set(session.id, text, { model: selectedModel });
    },
  });

  // Surface the warm container name for diagnostics. The actual stop
  // signal travels through stopHandle.execChild (set below) so the
  // warm container survives stop and the next dispatch is fast.
  if (stopHandle) stopHandle.workerName = containerName;

  let isError = false;
  const summaryParts = [];

  try {
    await sendStatus('Scout reading the codebase...');

    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat\n\n`); } catch {}
    }, 5000);

    // Persist a `'Claude Code progress'` system message and
    // incrementally append onProgress lines to its
    // metadata.progressLog. Mirrors the build-path persistence in
    // runClaudeCodeTool so that on page reload (or any re-fetch of
    // messages), the scout progress log still renders inline under
    // the "Scout reading the codebase…" status. Without this, progress
    // was SSE-transient — visible during the live turn, gone on the
    // next message reload — which the dev-chat UI surfaced as a
    // separate "Claude Code output" block that "disappeared after it
    // is done". The client pairs this row with the preceding scout
    // status line via the same pre-pass that handles build's
    // "Claude Code is running…" pairing.
    const { rows: progRows } = await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', 'Claude Code progress', $2) RETURNING id`,
      [session.id, JSON.stringify({ progressLog: [] })]
    );
    const progressMsgId = progRows[0].id;

    let result;
    try {
      result = await worker.execInWorker(session.id, {
        mode: 'scout',
        prompt: scoutPrompt,
        model: selectedModel,
        commitMsg: '',
        resumeSessionId: session.cc_session_id || null,
        branchName: session.branch_name,
        anthropicApiKey: userApiKey || null,
        onProgress: (text) => {
          send('cc_progress', { text });
          workerProgress.set(session.id, text, { model: selectedModel });
          pool.query(
            `UPDATE chat_session_messages SET metadata = jsonb_set(
              metadata, '{progressLog}',
              (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
            ) WHERE id = $2`,
            [JSON.stringify([text]), progressMsgId]
          ).catch(() => {});
        },
        onChild: (child) => {
          if (stopHandle) stopHandle.execChild = child;
        },
      });
    } finally {
      clearInterval(heartbeat);
    }

    // Same cc_session_id thread-through as runClaudeCodeTool — a scout
    // call early in the session is remembered when the user later
    // dispatches a real build, which keeps the spec ↔ implementation
    // mapping coherent and avoids paying full repo-read cost twice.
    const newCcId = result.sessionId || result.initSessionId || null;
    if (newCcId && newCcId !== session.cc_session_id) {
      await pool.query(
        'UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2',
        [newCcId, session.id]
      ).catch(() => {});
      session.cc_session_id = newCcId;
    }

    if (stopHandle && stopHandle.stopped) {
      isError = true;
      const byStr = stopHandle.stoppedBy ? ` by @${stopHandle.stoppedBy}` : '';
      await sendStatus(`Scout stopped${byStr}.`);
      summaryParts.push(`The scout was stopped${byStr} before it finished. The spec doc was not updated.`);
      return { toolResultText: summaryParts.join('\n\n') || 'Stopped.', isError: true };
    }

    const ccText = stripSpecWrapperFence((result.lastResultText || '').trim());

    if (result.fatalError) {
      isError = true;
      const msg = `Scout error: ${result.fatalError.substring(0, 200)}`;
      await sendStatus(msg);
      summaryParts.push(msg);
    } else if (result.ccIsError && !ccText) {
      isError = true;
      const msg = `Scout error: ${(ccText || 'unknown').substring(0, 200)}`;
      await sendStatus(msg);
      summaryParts.push(msg);
    } else if (!ccText) {
      isError = true;
      const msg = 'Scout finished but produced no spec text.';
      await sendStatus(msg);
      summaryParts.push(msg);
    } else {
      await pool.query(
        'UPDATE chat_sessions SET spec_md = $1 WHERE id = $2',
        [ccText, session.id]
      );

      const lineCount = ccText.split('\n').length;
      const preview = buildSpecPreview(ccText);
      // #27: freeze the scout's draft so the inline card opens its own content.
      const specVersion = await snapshotSessionSpec(pool, session.id, ccText);
      await sendStatus(
        `Scout drafted a ${lineCount}-line spec from the codebase.`,
        { specPreview: preview, specLines: lineCount, scoutOutput: ccText, specVersion }
      );
      send('spec_updated', { length: ccText.length, lines: lineCount, version: specVersion });
      summaryParts.push(
        `The scout investigated the repo and drafted a ${lineCount}-line markdown spec. `
        + `It now lives in the session's spec doc; the user can review it in the dev-chat spec viewer. When they're ready to ship, they'll ask you to dispatch the coding agent.`
      );
    }

    if (result.costUsd) {
      const ccCostCents = Math.round(result.costUsd * 100);
      // Scout costs land in the same llm_usage table as build dispatches —
      // they're real Anthropic spend on the same daily budget.
      if (!userApiKey) {
        await pool.query(
          `INSERT INTO llm_usage (user_id, date, total_cost_cents) VALUES ($1, CURRENT_DATE, $2)
           ON CONFLICT (user_id, date) DO UPDATE SET total_cost_cents = llm_usage.total_cost_cents + EXCLUDED.total_cost_cents`,
          [req.user.id, ccCostCents]
        );
      }
      send('usage', { costCents: ccCostCents, model: `scout/${selectedModel}`, byok: !!userApiKey });
    }
  } finally {
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
    if (stopHandle) stopHandle.execChild = null;
    // No destroyWorker here — the warm container stays so the next
    // dispatch (build or another scout) can reuse it. Idle eviction
    // and session archive both own teardown.
  }

  return {
    toolResultText: summaryParts.join('\n\n').slice(0, 4000)
      || (isError ? 'Scout did not complete successfully.' : 'Scout finished with no summary.'),
    isError,
  };
}

// Runs the full Claude Code pipeline for one tool invocation and returns
// a compact summary suitable for feeding back to the Mayor as a
// `tool_result`. All user-visible side effects (status events, progress
// log message, staging deploy, PR creation, vote reset, PR comment) are
// kept exactly as they were in the prior non-tool-use flow — this
// function is a mechanical extraction of that block, not a behavior
// change, except that it now returns a summary string instead of
// emitting a final [CODING AGENT COMPLETED] status at the end of the
// turn (we still emit that status, but ALSO return the text).
async function runClaudeCodeTool({
  pool, config, req, res, session, selectedModel,
  userMessage, toolPromptArg,
  repoOwner, repoName,
  send, sendStatus,
  stopHandle,
  userApiKey,
}) {
  activeWorkers.add(session.id);
  // Name the model in the spin-up status so users can see at a glance
  // that Claude Code is using the model they selected in the dropdown.
  // Without this, the only place the model is surfaced is the cost
  // line, which lands much later (fixes #33).
  const modelLabel = prettyModelLabel(selectedModel);
  await sendStatus(`Spinning up coding agent (${modelLabel})...`);

  await worker.ensureWorkerImage();

  // Platform conventions are injected fresh every turn, so updates to
  // src/prompts/app-conventions.md reach existing apps without touching
  // their repos. App-specific CLAUDE.md files (if present) are read by
  // Claude Code from the repo directly and take precedence for
  // app-specific matters only — the "authoritative" platform rules
  // below override any conflicting instruction in CLAUDE.md.
  //
  // The session's live spec doc (chat_sessions.spec_md) is also
  // injected when non-empty. The Mayor and the user have likely been
  // refining it over multiple turns; without it, CC would only see the
  // Mayor's compressed 1-4 sentence prompt arg and re-derive intent
  // from scratch. The platform-conventions block still overrides if
  // anything in the spec contradicts a platform-wide rule.
  const currentSpec = await loadSessionSpec(pool, session.id);
  const specBlock = currentSpec.trim()
    ? `

==== SPEC DOC (planning context, authoritative for what to build) ====

${currentSpec}

==== END SPEC DOC ====

The SPEC DOC above is the user's planning record for this session,
refined collaboratively with the Mayor. Treat it as the authoritative
description of WHAT to build and HOW IT SHOULD BEHAVE. The "CODING
TASK (from the Mayor)" line above tells you which slice to implement
in this dispatch — it is NOT a substitute for the spec, and you should
not re-derive intent from it when the spec covers the same ground.
Platform conventions still override the spec on any platform-wide
rule (auth, public/private tables, etc.).`
    : '';
  const claudePrompt = `USER REQUEST: "${userMessage}"

CODING TASK (from the Mayor):
${toolPromptArg}

==== PLATFORM CONVENTIONS (authoritative) ====

${getAppConventions()}

==== END PLATFORM CONVENTIONS ====
${specBlock}

A \`CLAUDE.md\` at the repo root, if present, contains **app-specific**
guidance: product intent, domain terms, opt-in policies, style. Follow
it for app-specific matters. On any platform-wide rule (auth,
public/private tables, USERNODE_ENV, do-not-push, etc.) the block above
is authoritative and overrides CLAUDE.md if they conflict.

The repo's \`CLAUDE.md\` may reference a hosted copy of the platform
conventions at \`https://${process.env.USERNODE_DOMAIN || 'social-vibecoding.usernodelabs.org'}/claude.md\` —
in dev-chat you already have those rules injected above, so ignore
that instruction here. It's for humans or Claude Code invocations
that run against this repo outside the harness.

A read-only helper \`usernode-issues\` is available (run it via Bash) — it prints the repo's open GitHub issues as JSON (\`{ issues: [{ number, title, body, labels, updatedAt, htmlUrl }], truncatedList }\`). Consult it if an open issue is relevant to what you're building; do not try to reach GitHub any other way.

INSTRUCTIONS:
- IMPLEMENT the requested changes fully. Do not just explore — write code.
- Spend minimal time reading files. Focus on writing and editing.
- Create or modify all necessary files to complete the request.
- If building something new, implement the full feature — don't stop partway.
- After all changes are made, stage everything with "git add -A" and commit
  with a clear message describing what was built.
- Do NOT ask questions or request clarification. Just build it.
- End your FINAL message with a testing block (optional, but strongly
  encouraged whenever the change is user-visible) so reviewers can try the
  change in the staging preview:

==== TESTING ====
path: /relative/path?demo=1
1. First step a tester should take.
2. What they should see if the change works.
==== END TESTING ====

  Rules for the testing block:
  - The "path:" line is optional. If present it must be a RELATIVE path
    within the app (starts with "/", no scheme or host) that lands the
    tester as close to the changed feature as possible. Omit the line when
    the app's root is the right place to start.
  - The steps are short markdown (numbered list preferred), written for a
    non-technical tester looking at a staging preview seeded with a copy of
    production data.
  - If the change is hard to demonstrate with production-cloned data, you
    MAY add a small staging-gated demo state (route or query param guarded
    by USERNODE_ENV === 'staging') and point "path:" at it. It must be a
    no-op in production.
  - The block must be the LAST thing in your final message. Skip the block
    entirely for changes with nothing user-visible to test.`;

  const commitMsg = github.safeMention(`Changes: ${userMessage.substring(0, 50)}`);

  // BYOK (#30): when the user has their own Anthropic key on file we
  // pass it down so the worker can hit api.anthropic.com directly.
  // When they don't, we pass null and worker.execInWorker routes the
  // SDK through the platform's Anthropic proxy (the platform key never
  // enters the worker container — see ANTHROPIC_BASE_URL/JWT in
  // src/services/worker.js and src/routes/anthropic-proxy.js).
  // execInWorker re-asserts these per-exec, so a key flip mid-session
  // takes effect on the next turn without needing a re-warm.
  const containerName = await worker.ensureWorker(session.id, {
    repoOwner,
    repoName,
    branchName: session.branch_name,
    anthropicApiKey: userApiKey || null,
    onProgress: (text) => {
      send('cc_progress', { text });
      workerProgress.set(session.id, text, { model: selectedModel });
    },
  });

  // Surface the container name for diagnostics + admin tooling. The
  // actual stop signal flows through stopHandle.execChild (set below)
  // so the warm container is preserved across stop — eviction is the
  // only path that destroys it.
  if (stopHandle) stopHandle.workerName = containerName;

  let ccLog = null;
  let stagingUrl = null;
  // Hoisted to function scope so the post-finally return can expose
  // commitHash to callers (currently used to drive PR-card metadata in
  // the timeline; previously also fed the now-removed /build-spec
  // backfill of chat_session_specs.commit_sha).
  let commitHash = null;
  // Accumulates a human-readable summary of what happened that we feed
  // back to the Mayor as tool_result content. Populated in the same
  // branches that emit status events so the two stay in sync.
  const summaryParts = [];
  let isError = false;

  try {
    await sendStatus('Claude Code is running...');

    const heartbeat = setInterval(() => {
      try { res.write(`:heartbeat\n\n`); } catch {}
    }, 5000);

    const { rows: progRows } = await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', 'Claude Code progress', $2) RETURNING id`,
      [session.id, JSON.stringify({ progressLog: [] })]
    );
    const progressMsgId = progRows[0].id;

    let result;
    try {
      result = await worker.execInWorker(session.id, {
        mode: 'build',
        prompt: claudePrompt,
        model: selectedModel,
        commitMsg,
        resumeSessionId: session.cc_session_id || null,
        branchName: session.branch_name,
        anthropicApiKey: userApiKey || null,
        onProgress: (text) => {
          send('cc_progress', { text });
          workerProgress.set(session.id, text, { model: selectedModel });
          pool.query(
            `UPDATE chat_session_messages SET metadata = jsonb_set(
              metadata, '{progressLog}',
              (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
            ) WHERE id = $2`,
            [JSON.stringify([text]), progressMsgId]
          ).catch(() => {});
        },
        onChild: (child) => {
          // Stash the host-side docker-exec child on stopHandle so
          // POST /api/sessions/:id/stop can SIGTERM just this exec
          // without taking down the warm container.
          if (stopHandle) stopHandle.execChild = child;
        },
      });
    } finally {
      clearInterval(heartbeat);
    }

    const newCcId = result.sessionId || result.initSessionId || null;
    if (newCcId && newCcId !== session.cc_session_id) {
      await pool.query(
        `UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2`,
        [newCcId, session.id]
      ).catch(() => {});
      session.cc_session_id = newCcId;
    }

    // If the user stopped mid-run we want to BAIL before push/PR/staging
    // work. The container has already been docker-stopped by the /stop
    // handler, so `result` reflects whatever CC had time to emit. We
    // persist a system message noting the stop so the chat timeline
    // shows it on refresh, then return early. The `finally` below still
    // tears down the worker + clears activeWorkers.
    if (stopHandle && stopHandle.stopped) {
      isError = true;
      const byStr = stopHandle.stoppedBy ? ` by @${stopHandle.stoppedBy}` : '';
      await sendStatus(`Claude Code stopped${byStr}.`);
      summaryParts.push(`Claude Code was stopped${byStr} before it finished. No commit was pushed.`);
      return {
        toolResultText: summaryParts.join('\n\n') || 'Stopped.',
        isError: true,
        ccLog: (result.rawStderr || '').substring(0, 5000) || null,
        stagingUrl: null,
      };
    }

    ccLog = (result.rawStderr || '').substring(0, 5000) || null;
    if (ccLog?.trim()) {
      send('cc_log', { log: ccLog });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata)
         VALUES ($1, 'system', $2, $3)`,
        [session.id, 'Claude Code log', JSON.stringify({ ccLog })]
      ).catch(() => {});
    }

    // #127: peel the optional "==== TESTING ====" block off the agent's
    // final message before anything downstream consumes it (Mayor summary,
    // ccOutput status, PR-metadata LLM prompt) so the raw markers never
    // leak into chat history or prompts. The parsed guidance is persisted
    // onto the session below, on the has-changes success path.
    const testing = testingNotes.extract(result.lastResultText || '');
    const ccText = testing.cleanedText;
    commitHash = result.sha;
    const hasChanges = result.ahead > 0 && !!commitHash;

    // #8: persist the latest behind-main count + broadcast so any open
    // dev-chat banner refreshes without waiting for the next session
    // refetch. We do this here (post-CC, before push outcome handling)
    // so the value lands even on the no-changes paths below — every
    // turn is an opportunity to learn the branch drifted.
    await persistBehindMain(pool, session, result.behind || 0);

    if (result.fatalError) {
      isError = true;
      const msg = `Worker error: ${result.fatalError.substring(0, 200)}`;
      await sendStatus(msg);
      summaryParts.push(msg);
    } else if (result.ccIsError && !hasChanges) {
      isError = true;
      const msg = `Claude Code error: ${(ccText || 'unknown').substring(0, 200)}`;
      await sendStatus(msg);
      summaryParts.push(msg);
    } else if (!hasChanges) {
      isError = true;
      const msg = result.exitCode !== 0
        ? `Claude Code exited with code ${result.exitCode} — no changes were made.`
        : 'No changes were made by Claude Code.';
      await sendStatus(msg);
      summaryParts.push(msg);
    } else {
      if (!result.pushOk) {
        await sendStatus('Warning: push reported a failure — staging may be stale.');
        summaryParts.push('Push reported a failure; staging may be stale.');
      }
      summaryParts.push(`Commit ${commitHash.substring(0, 8)} pushed to ${session.branch_name}.`);

      // #127: persist the turn's testing guidance BEFORE applyPrMetadata so
      // the PR body's "How to test" section (read back from the DB by id)
      // sees it. When this turn emitted a block, the latest one wins (both
      // columns overwritten — even a now-absent path); when it didn't,
      // earlier guidance is kept so a small follow-up turn doesn't wipe it.
      if (testing.testingMd || testing.testingPath) {
        await pool.query(
          `UPDATE chat_sessions SET testing_md = $1, testing_path = $2 WHERE id = $3`,
          [testing.testingMd, testing.testingPath, session.id]
        ).catch((err) => log.warn('sessions', 'Failed to persist testing guidance', { sessionId: session.id, err: err.message }));
        session.testing_md = testing.testingMd;
        session.testing_path = testing.testingPath;
      }

      const wasNewPR = !session.pr_number;
      const prResult = await prMetadata.applyPrMetadata({
        pool, session, repoOwner, repoName,
        userMessage, ccSummary: ccText, username: req.user.username,
        broadcast: (event, data) => send(event, data),
        apiKey: userApiKey,
        userId: req.user.id,
      });
      if (prResult && wasNewPR) {
        await sendStatus(`PR #${prResult.prNumber} created`);
        summaryParts.push(`Opened PR #${prResult.prNumber}: ${prResult.prUrl}`);
        events.record(pool, {
          type: events.EVENT_TYPES.PR_OPENED,
          userId: req.user.id,
          appId: session.app_id,
          sessionId: session.id,
          metadata: { prNumber: prResult.prNumber },
        });
      } else if (session.pr_number && !wasNewPR) {
        summaryParts.push(`Pushed to existing PR #${session.pr_number}.`);
      }

      await sendStatus('Building staging preview...');
      const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };

      // Staging build is a recoverable failure point: the commit + push +
      // PR creation above already landed real-world artefacts, but the
      // preview container can still fail to come up — most commonly when
      // `dapp.json` is missing a `staging_default` for a private secret
      // (`PrivateSecretMissingStagingDefaultError`) or when a required
      // secret hasn't been set in Settings → Secrets
      // (`MissingSecretsError`). Both are user-actionable: the first is a
      // manifest edit the agent itself can apply; the second needs an
      // admin to set the value in the platform UI.
      //
      // We catch here (rather than letting the throw escape to the
      // generic chat-handler `catch`) so the failure flows back to the
      // Mayor as a `tool_result` with `is_error: true`. That's what lets
      // the wrap-up turn explain the fix to the user — and, when the
      // user nudges the agent to retry, lets the next `dispatch_claude_code`
      // see the failure context in chat history. Without this, the Mayor
      // never finds out anything went wrong; the user sees a generic
      // "Chat error" toast and has no breadcrumb to follow.
      let stagingResult = null;
      let stagingErr = null;
      try {
        stagingResult = await staging.buildAndDeployStaging(config, session, app, commitHash);
      } catch (e) {
        stagingErr = e;
      }

      if (stagingResult) {
        await pool.query(
          `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
          [stagingResult.containerId, stagingResult.stagingUrl, session.id]
        );

        // Pre-warm the TLS cert now that staging_url is persisted (so Caddy's
        // on-demand `ask` gate will approve the host) and BEFORE emitting
        // `staging_ready` (which reveals the preview button). Otherwise the
        // first click pays the ~60-90s ZeroSSL cold-start. Bounded; never
        // blocks the deploy.
        await staging.warmStagingCert(session, stagingResult.hostname, stagingResult.stagingUrl);

        stagingUrl = stagingResult.stagingUrl;
        await sendStatus('Staging deployed!', { stagingUrl });
        // #127: ship the session's testing guidance (this turn's block, or
        // the kept-previous one off the session row) alongside the staging
        // URL so the client can offer "Test this change" without a refetch.
        send('staging_ready', {
          url: stagingUrl,
          testingMd: session.testing_md || null,
          testingPath: session.testing_path || null,
        });
        summaryParts.push(`Staging redeployed: ${stagingUrl}`);

        if (session.status === 'promoted') {
          const { rowCount } = await pool.query(
            `DELETE FROM pr_votes WHERE session_id = $1`,
            [session.id]
          );
          if (rowCount > 0) {
            const { sendSystemMessage, pushVoteUpdate } = require('../services/ws');
            pushVoteUpdate({
              sessionId: session.id,
              appSlug: session.app_slug,
              merged: false,
            });
            await sendSystemMessage(
              pool, session.app_id,
              `Votes reset on PR #${session.pr_number || session.id} — new commit ${commitHash.substring(0, 8)} pushed.`,
              'system'
            ).catch(() => {});
            log.info('sessions', 'Reset PR votes after new commit', {
              sessionId: session.id, commitHash: commitHash.substring(0, 8), votesDropped: rowCount,
            });
            summaryParts.push('Group-chat votes were reset for the new commit.');
          }
        }

        if (session.pr_number && repoOwner && repoName) {
          try {
            const pat = process.env.GITHUB_BOT_TOKEN;
            if (pat) {
              const { Octokit } = await import('@octokit/rest');
              const ok = new Octokit({ auth: pat });
              // #127: append the "How to test" section so the guidance is
              // visible right where reviewers find the staging link.
              const testingComment = prMetadata.buildTestingBlock(session.testing_md, session.testing_path);
              await ok.rest.issues.createComment({
                owner: repoOwner, repo: repoName,
                issue_number: session.pr_number,
                body: github.safeMention(`**Staging deployed!**\n\n${stagingResult.stagingUrl}\n\nCommit: ${commitHash.substring(0, 8)}${testingComment ? `\n\n${testingComment}` : ''}`),
              });
            }
          } catch (commentErr) {
            log.warn('sessions', 'Failed to comment on PR', { err: commentErr.message });
          }
        }

        log.info('sessions', 'Full dev cycle complete', { sessionId: session.id, commitHash: commitHash.substring(0, 8) });
      } else {
        isError = true;

        // Tailored remediation per error class. The `fix` field is what
        // ends up in the Mayor's tool_result and on the user's screen,
        // so it has to be self-contained: the Mayor doesn't read code,
        // and the user shouldn't have to either. Keep prose short but
        // concrete enough that "dispatch_claude_code" + this message is
        // sufficient to drive an automated fix on the next turn.
        let fix;
        let missingKeys = [];
        if (stagingErr instanceof staging.PrivateSecretMissingStagingDefaultError) {
          missingKeys = stagingErr.missingKeys || [];
          fix =
            `The PR's \`dapp.json\` declares ${missingKeys.length === 1 ? 'a secret' : 'secrets'} ` +
            `[${missingKeys.join(', ')}] as \`required\` + \`private\` (or the legacy alias \`sensitive: true\`), ` +
            `but with no \`staging_default\` (or \`default\`). Private secrets are intentionally NOT ` +
            `propagated from prod into staging clones, so without a manifest fallback the staging ` +
            `build refuses to start. ` +
            `\n\nFix: add \`"staging_default": "<value>"\` to each ${missingKeys.length === 1 ? 'entry' : 'entry'} in \`dapp.json\`. ` +
            `If the app's code degrades gracefully when the secret is unset, use the empty string \`""\`. ` +
            `For paid services use a vendor sandbox key (e.g. Stripe \`sk_test_...\`). ` +
            `Never copy the prod value into \`staging_default\`. ` +
            `See \`app-conventions.md\` "Public vs private secrets" for the full rubric. ` +
            `\n\nThe agent can apply this fix directly: dispatch \`dispatch_claude_code\` with a prompt ` +
            `like "edit dapp.json so each of [${missingKeys.join(', ')}] has staging_default set to <chosen value>".`;
        } else if (stagingErr instanceof staging.MissingSecretsError) {
          missingKeys = stagingErr.missingSecrets || [];
          fix =
            `The PR's \`dapp.json\` declares ${missingKeys.length === 1 ? 'a required secret' : 'required secrets'} ` +
            `[${missingKeys.join(', ')}] that ${missingKeys.length === 1 ? 'has' : 'have'} no stored value in this ` +
            `app's secret store, and no \`default\` in the manifest. ` +
            `\n\nFix: an admin needs to set ${missingKeys.length === 1 ? 'this value' : 'these values'} in the platform UI ` +
            `(Settings → Secrets) before staging can build. The agent CANNOT fix this from code — ` +
            `secret values are intentionally not committed to source. ` +
            `If a manifest \`default\` is appropriate (i.e. the value is genuinely public), the agent can ` +
            `instead add it to \`dapp.json\` via \`dispatch_claude_code\`.`;
        } else {
          fix =
            `Underlying error: ${(stagingErr && stagingErr.message) || String(stagingErr)}. ` +
            `This is most likely an infrastructure or build-time failure (Docker build, network, ` +
            `image cache, etc.) rather than a manifest issue. The agent can suggest the user retry, ` +
            `inspect platform logs, or — if the build error message implicates the dapp's own code — ` +
            `dispatch \`dispatch_claude_code\` to investigate.`;
        }

        const message =
          `Staging build failed.\n\n` +
          `What still happened: commit ${commitHash.substring(0, 8)} was pushed to ${session.branch_name}` +
          (session.pr_number ? ` and PR #${session.pr_number} was created/updated` : '') +
          `. Only the staging preview container is missing — there is no preview URL for this commit.\n\n` +
          fix;

        // Defensive: if buildAndDeployStaging ever returned null/undefined
        // without throwing (it shouldn't — its contract is throw-or-return-
        // result), stagingErr would be null here. Coerce so we still emit
        // a meaningful event instead of NPE'ing inside this branch.
        const errMsg = (stagingErr && stagingErr.message) || 'Unknown staging failure (no error thrown but no result returned)';
        const errName = (stagingErr && stagingErr.name) || 'Error';

        await sendStatus('Staging build failed', { error: errMsg });
        send('staging_failed', {
          error: errMsg,
          errorName: errName,
          missingKeys,
        });
        summaryParts.push(message);

        log.error('staging', 'Staging build failed (surfaced to Mayor)', {
          sessionId: session.id,
          slug: app.slug,
          errName,
          err: errMsg,
          missingKeys,
        });
      }
    }

    // Debit the platform's daily ledger for whatever Claude Code spent
    // — even when the run produced no commit (CC error, no-op turn,
    // partial-failure with `result.fatalError`). The Anthropic invoice
    // is paid regardless of whether code changes landed; without this
    // we'd silently let users burn budget on tool-only / failed turns
    // and only debit on the success branch.
    if (result.costUsd) {
      const ccCostCents = Math.round(result.costUsd * 100);
      await pool.query(
        `INSERT INTO llm_usage (user_id, date, total_cost_cents) VALUES ($1, CURRENT_DATE, $2)
         ON CONFLICT (user_id, date) DO UPDATE SET total_cost_cents = llm_usage.total_cost_cents + EXCLUDED.total_cost_cents`,
        [req.user.id, ccCostCents]
      );
      send('usage', { costCents: ccCostCents, model: `claude-code/${selectedModel}` });
    }

    if (ccText) {
      await sendStatus('Claude Code finished', { ccOutput: ccText });
      // Prepend CC's own description so the Mayor leads with what was
      // actually built, with our outcome bullets as supplementary context.
      summaryParts.unshift(`What the agent did:\n${ccText}`);
    }
  } finally {
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
    if (stopHandle) stopHandle.execChild = null;
    // Warm container intentionally NOT destroyed — the next dispatch
    // (build or scout) reuses it. Idle eviction (worker.evictWorker via
    // the sweeper in server.js) and session archive own teardown.
  }

  const toolResultText = summaryParts.join('\n\n').slice(0, 4000)
    || (isError ? 'Claude Code did not complete successfully.' : 'Claude Code finished with no summary.');
  // commitSha is exposed (in addition to ccLog/stagingUrl) for the
  // caller's bookkeeping (PR card metadata, etc.). Null if CC made no
  // changes.
  return { toolResultText, ccLog, stagingUrl, isError, commitSha: commitHash || null };
}

function getMayorSystemPrompt(appName, isWorkerBusy, currentSpec, selfHosted, prContext) {
  // The spec-edit tool name shown to the model depends on whether a
  // spec already exists: write_spec when the doc is empty (no anchor
  // to edit against), edit_spec once it has content (anchored
  // replacement preserves what the user already accepted). The actual
  // tool exposed to the Anthropic API is gated the same way at the
  // call site (see `tools` construction in the chat handler).
  const specIsEmpty = !((currentSpec || '').trim());
  const specToolName = specIsEmpty ? 'write_spec' : 'edit_spec';

  const toolNote = isWorkerBusy
    ? `\n\nSTATUS: A coding agent IS currently running for this session — the dispatch_claude_code, dispatch_scout, and ${specToolName} tools are NOT available right now. Just chat with the user; tell them the agent is still working and they can follow up once it finishes.`
    : `\n\nSTATUS: No coding agent is running. You MAY use dispatch_claude_code, dispatch_scout, or ${specToolName} when appropriate (see the rules below). Otherwise just reply in text and do not call any tools.`;

  // Platform conventions are authoritative; app-specific guidance in a
  // repo CLAUDE.md takes precedence for app-specific matters only. See
  // src/prompts/app-conventions.md for the source of truth — edit
  // there, restart, and both Mayor + Claude Code pick up the update.
  const conventionsBlock = `

==== PLATFORM CONVENTIONS (authoritative) ====

${getAppConventions()}

==== END PLATFORM CONVENTIONS ====

When planning features that touch sensitive data (direct messages,
user accounts with passwords, payments, API keys, personal info),
briefly note in your plan that the relevant tables will be marked
private and staging will seed fake rows — so the user knows what
to expect on the staging preview.`;

  // Live-spec block: the Mayor sees the current spec_md verbatim every
  // turn so it can answer "what's in the spec?" accurately and so
  // edit_spec calls can quote real existing text. Re-injected fresh
  // before each phase (see chat handler) so a write_spec / scout /
  // edit_spec earlier in the same turn is reflected in phase-2.
  const specBlock = `

==== CURRENT SPEC DOC (live draft) ====

${specIsEmpty ? '(empty — no spec drafted yet)' : currentSpec}

==== END CURRENT SPEC ====`;

  // Session ↔ PR binding guidance. A session maps to exactly ONE branch
  // and ONE pull request: every dispatch in this chat lands on the same
  // PR, and the group votes on it as one unit. When the session already
  // has a PR and the user asks for a DISTINCT new change, nudge them to
  // start a new change (a fresh session) so PRs stay focused — instead of
  // silently bundling unrelated work (the multi-change-per-session
  // problem). The user always wins if they insist on adding it here.
  const prBlock = prContext && prContext.prNumber
    ? `

==== THIS SESSION'S PULL REQUEST ====

This chat session maps to ONE branch and ONE pull request: PR #${prContext.prNumber}${prContext.prTitle ? ` — "${prContext.prTitle}"` : ''} (status: ${prContext.status || 'active'}). Every change you dispatch in this session is added to that SAME PR, and the group votes on it as a single unit.

If the user's next request is a DISTINCT, separate change — a new feature or fix that isn't part of what PR #${prContext.prNumber} already covers — do NOT silently bundle it in. In one sentence, point out that this session already has its own PR, and suggest they use the "Start a new change" button at the top of the chat so the new work gets its own focused PR the group can vote on separately. If they confirm they want it added to this PR anyway, go ahead.${prContext.status === 'promoted' ? '\nThis PR has already been PROPOSED to the group for voting, so additional changes here modify something people may already be voting on. Lean toward suggesting a new change unless the user is clearly fixing or refining THIS PR.' : ''}

==== END PULL REQUEST ====`
    : '';

  // Conditional spec-tool description. Only one of these tools is
  // exposed to the API at any moment, so the prompt only describes
  // the one the model can actually call.
  const specToolItem = specIsEmpty
    ? `2) write_spec(content) — cheap in-process spec edit, ms-fast
   The spec is currently empty. Use this to draft an INITIAL spec when scout would be overkill (e.g. the user gave you a clear, self-contained design and just wants it captured). Pass the FULL spec content as markdown. Once a spec exists, this tool is replaced by edit_spec — you cannot overwrite an existing spec wholesale.
   Cannot fact-check itself against the repo, so don't use it for changes where you need to confirm what the code currently does — use dispatch_scout for that.`
    : `2) edit_spec(old_text, new_text) — anchored in-process spec edit, ms-fast
   The current spec is shown verbatim in CURRENT SPEC DOC above. Use this for ALL revisions. Pass an EXACT verbatim substring from the current spec as old_text and the replacement as new_text — old_text MUST match the current spec character-for-character (whitespace included) and MUST be unique (include surrounding context if needed). Empty new_text deletes the matched section. To add a new section, anchor on a unique nearby snippet and include it in both old_text and new_text.
   If old_text is not found or is ambiguous, the call fails with a clear error and you can retry on the user's next message — do NOT silently regenerate the spec from scratch.
   Cannot fact-check itself against the repo, so don't use it for changes where you need to confirm what the code currently does — use dispatch_scout for that.`;

  return `You are the Mayor — a friendly project manager for the app "${appName}" on Usernode Social Vibecoding.

YOUR ROLE:
You talk to the user in plain English and decide whether their latest message needs the coding agent (Claude Code) to actually edit the repo, OR needs spec-stage planning before any code is written. You are NOT a developer — never write code, file contents, diffs, or implementation details. Keep replies to 1-4 sentences.

THE SPEC DOC:
Every session has a markdown SPEC DOC that the user can read in the dev-chat spec viewer (a side-panel they open via the spec preview cards in the chat). It is your collaborative working surface for planning before code is written. The current spec is included verbatim below in the CURRENT SPEC DOC block — refer to it whenever you discuss, summarize, or edit the spec. The viewer is read-only: the user cannot hand-edit the spec, so all revisions go through you. When they're happy with the spec they'll ask you to dispatch the coding agent in chat — you don't need to call dispatch_claude_code just because the spec is done; the user owns that decision.

SPEC QUESTIONS — KEEP THEM RARE:
Do not pad the spec with open questions. Only include a "Questions" section for things that genuinely BLOCK implementation — decisions the coding agent cannot reasonably make on its own and that would change what gets built. Wherever you can, make a sensible default choice and state it instead of asking. Non-blocking items belong under "Considerations" (trade-offs, assumptions, things to keep in mind) or "Deferred work" (out-of-scope or follow-up items) — never phrase those as questions. When you write or edit the spec, prefer decisions over questions.

THREE TOOLS, in priority order:

1) dispatch_scout(prompt) — read-only repo investigation, slow (~30-60s)
   Use for the FIRST substantive spec work in a session, when you need to know how the app is currently built. The scout is the coding agent in read-only mode: it reads files (Read/Glob/Grep), writes prose, and is structurally forbidden from editing or committing. Output replaces the session's spec doc.
   Heuristic: if your reply would be "I'd need to look at the code to answer that", that's a dispatch_scout signal — not an excuse to guess.
   Do NOT use for small revisions. It's slow and expensive.

${specToolItem}

3) dispatch_claude_code(prompt) — full coding agent, slow + writes code
   Calls the coding agent to clone, edit files, commit, and push to the dev branch. Staging auto-rebuilds. Only call when:
   * The user has made a clear, concrete change request, AND
   * No spec stage is needed first (small/obvious change), OR the user has asked you to "just build it" or similar.
   Before calling, say one sentence describing what you're going to have the agent build (e.g. "I'll add a leaderboard page sorted by score.") — then call the tool.

GENERAL RULES (apply to all tools):
- DO NOT call any tool when the user is:
  * asking what happened in a past turn, how something works, or why you did something
  * chatting, brainstorming, or just acknowledging
  * giving feedback that isn't a concrete change request ("this looks bad" alone — ask what they want instead)
  * asking for something that looks like a brand-new, standalone app unrelated to "${appName}" (e.g. they're chatting here but describe building a totally different product). In that case, DO NOT dispatch — instead, gently point them to the home page to create a new app, e.g. "That sounds like a separate app from ${appName}. You can head back to the home screen and spin up a new app for it." Only dispatch if they confirm they want it added to this app.
- If the request is vague, ask a clarifying question INSTEAD of calling any tool. Never dispatch while also asking for clarification.
- At most ONE tool call per user message.
- Never call ${specToolName} and dispatch_claude_code in the same turn. The user dispatches the build themselves.

AFTER A TOOL RETURNS:
You'll get a short summary of what happened. Write a 1-3 sentence reply to the user in plain English, referencing the spec doc / staging URL / PR if present. For dispatch_scout: tell them the spec was drafted and is available in the spec viewer. For ${specToolName}: tell them what you changed in the spec. For dispatch_claude_code: summarize what was built. If anything failed, explain briefly and suggest next steps.
- IMPORTANT — spec→build handoff: after dispatch_scout, write_spec, or edit_spec, the spec is only PLANNED, not built. End your reply with a one-line next step that makes this explicit, e.g. "When this looks right, just tell me to build it and I'll have the coding agent implement it." Nothing gets built until the user asks — don't let a finished spec read as a finished change. (After dispatch_claude_code the change IS built, so no handoff line is needed.)

STAGING BUILD FAILURES (recoverable):
A dispatch_claude_code tool_result may report that the commit/push/PR succeeded but the staging preview failed to build. The two common causes — both surfaced verbatim in the tool_result with explicit "Fix:" instructions:
  * Missing \`staging_default\` for a private secret in dapp.json — the agent CAN fix this directly. Acknowledge the issue to the user, propose the concrete fix in one sentence (e.g. "I'll add \`staging_default: \"\"\` to SENDER_APP_SECRET_KEY since the app degrades gracefully without it"), and on the user's next confirmation call dispatch_claude_code with a prompt naming the keys and the value to use.
  * Missing required secret in the platform secret store — the agent CANNOT fix this; the user (or admin) needs to set the value in Settings → Secrets. Tell them which key, point them at the Settings UI, and offer to retry once it's set.
For other staging failures (Docker build, network, image cache), explain briefly and offer to retry. Do NOT pretend a failed staging build succeeded — the user can see the build status in the chat.

HISTORY CONTEXT:
Some assistant turns in this conversation contain "[CODING AGENT COMPLETED]:" — that is a summary from a PAST coding-agent run, written by the system, not by you. You may reference it when the user asks an INFORMATIONAL question about a past turn (e.g. "what did you do?", "why did you change X?", "what files were touched?") — quote or paraphrase to answer.

You MUST NOT, under any circumstances:
- Write the literal string "[CODING AGENT COMPLETED]" in your reply. That marker is reserved for the harness; emitting it yourself fakes a coding-agent run that never happened.
- Paraphrase a past summary as a substitute for dispatching a new run. If the user reports a bug, regression, or "still not quite right" — even if a previous run targeted the same area — that is a NEW change request and you MUST call dispatch_claude_code (assuming the tool is available per STATUS). Past summaries are read-only history; they cannot fix new bugs.${toolNote}${conventionsBlock}${selfHosted ? getSelfHostedRefuseList() : ''}${prBlock}${specBlock}`;
}

async function getFilesFromContainer(appSlug) {
  const containerName = `usernode-app-${appSlug}`;
  try {
    // List files in the container's /app directory
    const { stdout: fileList } = await docker.execFileAsync('docker', [
      'exec', containerName, 'find', '/app', '-type', 'f',
      '-not', '-path', '*/node_modules/*',
      '-not', '-path', '*/.git/*',
      '-not', '-name', 'package-lock.json',
    ], { timeout: 10000 });

    const files = fileList.trim().split('\n').filter(Boolean).slice(0, 20);
    const contents = [];

    for (const filePath of files) {
      try {
        const { stdout } = await docker.execFileAsync('docker', [
          'exec', containerName, 'cat', filePath,
        ], { timeout: 5000 });
        const relativePath = filePath.replace('/app/', '');
        if (stdout.length < 50000) {
          contents.push(`--- ${relativePath} ---\n${stdout}`);
        }
      } catch {}
    }

    if (contents.length > 0) {
      log.info('sessions', 'Loaded file context from container', { container: containerName, fileCount: contents.length });
      return contents.join('\n\n');
    }
  } catch (err) {
    log.warn('sessions', 'Failed to read files from container', { container: containerName, err: err.message });
  }
  return null;
}

function parseFileChanges(text) {
  const files = [];
  const regex = /```\w*:?([\w/._-]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const path = match[1];
    const content = match[2];
    if (path && content && !path.match(/^\d+$/)) {
      files.push({ path, content });
    }
  }
  return files;
}

async function buildStagingFromFiles(config, session, app, fileChanges, hash) {
  const fs = require('fs');
  const path = require('path');
  const dbManager = require('../services/db-manager');

  const containerName = `usernode-staging-${app.slug}--${session.id}`;
  const imageName = `usernode-staging-${app.slug}-${session.id}:${hash.substring(0, 6)}`;

  log.info('sessions', 'Building staging from chat files', { sessionId: session.id });

  // Get the current production app's files as a base
  const prodContainer = `usernode-app-${app.slug}`;
  const tempDir = `/tmp/usernode-staging-build-${session.id}`;

  await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});
  fs.mkdirSync(tempDir, { recursive: true });

  // Copy files from production container as a base
  try {
    await docker.execFileAsync('docker', ['cp', `${prodContainer}:/app/.`, tempDir], { timeout: 30000 });
  } catch (err) {
    log.warn('sessions', 'Could not copy from production container, using empty base', { err: err.message });
  }

  // Remove node_modules from copy (we'll npm install fresh)
  await docker.execFileAsync('rm', ['-rf', path.join(tempDir, 'node_modules')]).catch(() => {});

  // Apply the AI's file changes on top
  for (const file of fileChanges) {
    const filePath = path.join(tempDir, file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content);
  }

  // Ensure Dockerfile exists
  if (!fs.existsSync(path.join(tempDir, 'Dockerfile'))) {
    fs.writeFileSync(path.join(tempDir, 'Dockerfile'), `FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
`);
  }

  // Build
  await docker.buildImage(tempDir, imageName);
  await docker.execFileAsync('rm', ['-rf', tempDir]).catch(() => {});

  // Clone DB. cloneDatabase mints a fresh per-clone postgres role —
  // see staging.js for the rationale (one-shot password, dropped on
  // teardown, never persisted on the platform).
  const prodDbName = dbManager.appDbName(app.slug);
  const stagingDbName = dbManager.stagingDbName(app.slug, `s${session.id}`, hash);
  const { password: stagingDbPassword } = await dbManager.cloneDatabase(prodDbName, stagingDbName);
  const stagingDbUrl = dbManager.connectionUrl(stagingDbName, stagingDbPassword);

  // Stop old staging
  await docker.stopAndRemove(containerName).catch(() => {});

  // Run
  const containerId = await docker.runContainer(containerName, {
    image: imageName,
    env: {
      DATABASE_URL: stagingDbUrl,
      JWT_SECRET: config.jwtSecret,
      PORT: '3000',
    },
    port: 3000,
  });

  await docker.waitForHealthy(containerName, 3000, '/health');

  // Get the host port for local dev access
  const hostPort = await docker.getHostPort(containerName, 3000);
  // No Caddy route to register — the wildcard site maps this hostname to
  // `containerName` (usernode-staging-<slug>--<id>) and issues TLS
  // on-demand. See Caddyfile + services/caddy.js.
  const hostname = caddy.stagingHostname(app.slug, `s${session.id}`);

  const stagingUrl = hostPort
    ? `http://localhost:${hostPort}`
    : `https://${hostname}`;

  // TLS pre-warm happens in the caller (staging.warmStagingCert) AFTER the
  // session's staging_url is persisted — Caddy's on-demand `ask` gate keys
  // off that row, so warming here would be refused. See staging.js for the
  // full ordering rationale.

  return { containerId, stagingUrl, hostname };
}

module.exports = { sessionRoutes, getActiveWorkerCount, runSyncMain, persistBehindMain, buildSpecPreview, stripSpecWrapperFence };
