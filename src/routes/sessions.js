'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const llm = require('../services/llm');
const github = require('../services/github');
const webFetch = require('../services/web-fetch');
const prMetadata = require('../services/pr-metadata');
const sessionTitles = require('../services/session-title');
const testingNotes = require('../services/testing-notes');
const staging = require('../services/staging');
const visuals = require('../services/visuals');
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
const notifications = require('../services/notifications');
// runSyncMain + persistBehindMain now live in services/sync-main.js so
// the conflict-resolver can drive a sync turn without a route-requires-
// route cycle. Re-exported below for backwards compatibility. Route
// handlers call through the module object (syncMainSvc.*) so tests can
// monkey-patch individual functions, mirroring how worker.isInFlight
// is stubbed in the route suites.
const syncMainSvc = require('../services/sync-main');
const { runSyncMain, persistBehindMain } = syncMainSvc;

// Track sessions with active Claude Code workers. The Set lives in a
// shared module so services/sync-main.js writes to the same instance
// the chat handler and server.js's drain logic read.
const { activeWorkers, getActiveWorkerCount } = require('../services/active-workers');

// Per-session stop handles, populated while a chat turn is in flight.
// Shape: { abort: AbortController, workerName: string|null, phase: 'mayor1'|'cc'|'mayor2', stopped: boolean, stoppedBy: string|null }
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

// #138: every interactive turn completion now creates + pushes a
// session_done notification UNCONDITIONALLY (the persistent green bell
// item the user can return to any time), not just when notify_on_done was
// armed. createSessionDoneNotification's own unread-dedup (at most one
// unread session_done per (user, session) via INSERT … WHERE NOT EXISTS)
// collapses a back-and-forth conversation into a single pending item, so
// this doesn't spam. We still clear notify_on_done for tidiness, but it no
// longer gates creation. Called fire-and-forget from the chat handler's
// done hook — never throws into the SSE path.
async function notifySessionDone(pool, sessionId) {
  try {
    const { rows } = await pool.query(
      `UPDATE chat_sessions SET notify_on_done = FALSE
       WHERE id = $1
       RETURNING user_id, app_id`,
      [sessionId]
    );
    if (!rows.length) return;
    const created = await notifications.createSessionDoneNotification(pool, {
      userId: rows[0].user_id, appId: rows[0].app_id, sessionId,
    });
    if (created.length) await notifications.hydrateAndPush(pool, created[0]);
  } catch (err) {
    log.warn('sessions', 'session_done notify failed', { sessionId, err: err.message });
  }
}

// #161: headless auto-solve completion notification. Always fired at
// the runner's terminal writes (ready/failed) — starting an auto-solve
// opts the clicking user into the completion notification, no arming.
// Best-effort: a failed insert/push must never fail the run itself.
async function notifyAutoSolveDone(pool, { userId, appId, sessionId, detail }) {
  try {
    const created = await notifications.createAutoSolveDoneNotification(pool, {
      userId, appId, sessionId, detail,
    });
    if (created.length) await notifications.hydrateAndPush(pool, created[0]);
  } catch (err) {
    log.warn('sessions', 'auto_solve_done notify failed', { sessionId, err: err.message });
  }
}

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

// #199: render the OPEN PROPOSALS block injected into the Mayor's system
// prompt on the FIRST turn of a fresh session, so the Mayor can spot when
// the user's request duplicates an existing promoted/merging proposal and
// suggest voting on that instead of starting redundant work. Pure function
// over rows from the candidate query in the chat handler; returns '' when
// there is nothing to show. Advisory only — every caller fails open.
const OPEN_PROPOSALS_MAX = 10;

function buildOpenProposalsBlock(proposals, currentUsername) {
  const list = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
  if (!list.length) return '';

  const entries = list.slice(0, OPEN_PROPOSALS_MAX).map((p) => {
    const title = (p.pr_title || '').trim();
    const prRef = p.pr_number
      ? `PR #${p.pr_number}${title ? ` — "${title}"` : ''}`
      : `${title ? `"${title}"` : 'Untitled proposal'} (no PR yet)`;
    const author = p.username
      ? `${p.username}${currentUsername && p.username === currentUsername ? " (this user's own proposal)" : ''}`
      : 'unknown';
    const lines = [
      `- ${prRef}`,
      `  Author: ${author} · Status: ${p.status || 'promoted'}${p.pr_url ? ` · ${p.pr_url}` : ''}`,
    ];
    const issues = Array.isArray(p.linked_issues) ? p.linked_issues.filter((n) => Number.isInteger(n)) : [];
    if (issues.length) lines.push(`  Issues: ${issues.map((n) => `#${n}`).join(', ')}`);
    const spec = buildSpecPreview((p.spec_md || '').trim(), 500);
    if (spec) lines.push(`  Spec excerpt: ${spec.replace(/\s+/g, ' ')}`);
    return lines.join('\n');
  });

  return `

==== OPEN PROPOSALS IN THIS APP ====

This is the user's FIRST message in a new session. The app already has the following open proposals (promoted/merging PRs the group is voting on):

${entries.join('\n')}

Before dispatching ANY tool, check whether the user's request SUBSTANTIALLY duplicates one of these proposals — i.e. the existing proposal would deliver the same feature or fix. Touching the same area with a different goal is NOT a duplicate; when unsure, do not raise it.

- If it duplicates one: do NOT dispatch any tool. Instead ask, in 1-2 sentences, naming the PR number and title explicitly so the reference survives into later turns, e.g. "There's already an open proposal — PR #N 'title' by author — that looks like it covers this. Want to vote on that in the group chat instead?" Include the PR link when there is one. If the matching proposal is the user's own, suggest returning to that session instead of voting. This follows the same rule as the clarity gate: never ask and dispatch in the same turn.
- If the user then confirms they want the existing one: point them to the group-chat vote panel; do not dispatch anything.
- If the user says theirs is different or additive: proceed as normal, AND ensure the differentiation is captured — when dispatching the scout, tell it to include a short "How this differs from PR #N" section in the spec; when dispatching the coding agent directly, restate the user's differentiation in your one-sentence preamble and include it in the dispatch prompt.

==== END OPEN PROPOSALS ====`;
}

// Unwrap a whole-document ```markdown fence a scout/spec-author LLM sometimes
// emits around the entire spec (see src/services/spec-format.js for the why
// and the conservative rules). Re-exported below so existing importers and
// tests can keep requiring it from this module.
const { stripSpecWrapperFence } = require('../services/spec-format');

// #27: freeze the current spec content as a new immutable version in
// chat_session_specs and return its version number. Every spec mutation
// (scout) calls this and tags its inline spec
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
  //     - active   = 'active'-status sessions only — the set counting
  //                  against the per-user slot cap (#193). Promoted
  //                  sessions no longer count (they're un-pausable while
  //                  their PR is up for vote).
  //     - promoted = 'promoted'-status sessions (PR in a merge vote;
  //                  violet in the UI, exempt from the per-user cap)
  //     - paused   = paused-status sessions (no warm worker)
  //     - busy     = subset of active+promoted where CC is mid-turn right now
  //     - total    = active + promoted + paused (every non-archived row
  //                  we returned)
  router.get('/api/me/active-sessions', async (req, res) => {
    try {
      // last_activity_at = the newest message in the session's thread,
      // falling back to the session's own creation time. The dev tab's
      // card list sorts session rows by this ("most recent activity"),
      // not by creation order.
      const { rows } = await pool.query(
        `SELECT cs.id, cs.branch_name, cs.pr_number, cs.pr_url, cs.pr_title,
                cs.session_title, cs.status, cs.linked_issues, cs.created_at,
                GREATEST(cs.created_at, COALESCE(m.last_message_at, cs.created_at)) AS last_activity_at,
                a.slug AS app_slug, a.name AS app_name
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         LEFT JOIN LATERAL (
           SELECT MAX(created_at) AS last_message_at
           FROM chat_session_messages
           WHERE session_id = cs.id
         ) m ON TRUE
         WHERE cs.user_id = $1 AND cs.status IN ('active', 'promoted', 'paused')
           AND cs.is_headless = FALSE
         ORDER BY last_activity_at DESC`,
        [req.user.id]
      );
      const sessions = rows.map((s) => ({
        ...s,
        busy: activeWorkers.has(s.id) || worker.isInFlight(s.id),
      }));
      const totals = sessions.reduce(
        (acc, s) => {
          if (s.status === 'paused') acc.paused += 1;
          else if (s.status === 'promoted') acc.promoted += 1;
          else acc.active += 1;
          if (s.busy) acc.busy += 1;
          return acc;
        },
        { active: 0, promoted: 0, paused: 0, busy: 0 }
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
        `SELECT id, branch_name, pr_number, pr_url, pr_title, session_title, staging_url, status, linked_issues, behind_main, created_at
         FROM chat_sessions
         WHERE app_id = $1 AND user_id = $2 AND is_headless = FALSE
         ORDER BY created_at DESC`,
        [appRows[0].id, req.user.id]
      );

      // `warm` = a worker container currently exists for the session. The
      // session list uses it to decide whether a promoted row still has a
      // worker to free (and the create-session cap counts the same thing).
      const warmIds = new Set(worker.warmRegistrySnapshot().map((w) => w.sessionId));
      for (const s of rows) s.warm = warmIds.has(s.id);

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

      // Per-user cap (#193): only 'active' sessions count toward the
      // slot budget. Promoted sessions (PRs up for a merge vote) are
      // deliberately un-pausable — their status must stay 'promoted' so
      // the vote endpoints keep working — so counting them here would
      // leave the user no way to free a slot by pausing. The separate
      // maxUserPromotedSessions cap (enforced at promote time) bounds
      // how many vote-only sessions one user can accumulate.
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
         WHERE user_id = $1 AND status = 'active' AND is_headless = FALSE`,
        [req.user.id]
      );
      if (parseInt(countRows[0].cnt) >= config.maxUserSessions) {
        return res.status(429).json({ error: `You already have ${config.maxUserSessions} running sessions. Pause or archive one first.` });
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

      // #287: an optional issue number links this dev chat back to the
      // issue row's "Create PR" button so the row can swap to "Open
      // Session" for this viewer. Validate to a positive integer; anything
      // else (incl. the generic "+ New chat" path that sends no body)
      // stores NULL.
      const rawIssue = req.body && req.body.issueNumber;
      const issueNumber = Number.isInteger(rawIssue) && rawIssue > 0 ? rawIssue : null;

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
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, created_from_issue_number)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING *`,
        [app.id, req.user.id, branchName, issueNumber]
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

  // #155: start a HEADLESS auto session for a GitHub issue.
  //
  // Unlike POST /sessions this is not connected to any user's dev chat: it
  // runs ONE unattended Mayor turn (scout → spec, build → pushed commit, or
  // a plain-text question) seeded with the issue, then parks as
  // headless_status='ready' so any collaborator can clone it via
  // POST /api/sessions/:id/clone-headless. Billed to the clicking user,
  // limit-first (#212): their daily budget while it lasts, then their BYOK
  // key when on file — the UI shows a confirmation warning + model
  // selector before calling this.
  //
  // The run may create + push its branch and deliberately builds a staging
  // preview, but never opens a PR — the PR is created lazily on a cloned
  // session's branch at propose time (see runClaudeCodeTool's `headless`
  // flag).
  router.post('/api/apps/:slug/issues/:number/headless-session', drainGuard, async (req, res) => {
    try {
      const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'collab');
      if (!app) return res.status(404).json({ error: 'App not found' });

      const issueNumber = parseInt(req.params.number, 10);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
        return res.status(400).json({ error: 'Invalid issue number' });
      }

      const [, repoOwner, repoName] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (!github.isEnabled() || !repoOwner || !repoName) {
        return res.status(400).json({ error: 'No GitHub repo configured for this app' });
      }
      if (!llm.isEnabled()) return res.status(503).json({ error: 'LLM not configured' });

      // One auto session per issue at a time: 'generating' means a run is
      // in flight; 'ready' means the start-from button should be used
      // instead. 'failed' rows don't block a retry, and neither does a
      // 'ready' run that ended with outcome 'question' (#150) — the whole
      // point is to answer on the issue and press Generate proposal again.
      const { rows: existingRows } = await pool.query(
        `SELECT id, headless_status FROM chat_sessions
         WHERE app_id = $1 AND is_headless = TRUE AND headless_issue_number = $2
           AND headless_status IN ('generating', 'ready')
           AND NOT (headless_status = 'ready' AND headless_outcome = 'question')
         ORDER BY created_at DESC LIMIT 1`,
        [app.id, issueNumber]
      );
      if (existingRows.length) {
        return res.status(409).json({
          error: existingRows[0].headless_status === 'generating'
            ? 'An auto session is already being generated for this issue.'
            : 'This issue already has a ready auto session — start a session from it instead.',
        });
      }

      // Billed to the clicking user, limit-first (#212): their shared
      // daily allowance while it has headroom, their BYOK key once it's
      // exhausted — exactly like a chat turn. No headroom + no key → 429.
      const billing = await limits.resolveBillingPath(pool, config.jwtSecret, req.user.id);
      if (billing.error) return res.status(429).json({ error: billing.error });
      const userApiKey = billing.apiKey;

      // Headless sessions don't count against the clicking user's session
      // cap (they're shared, unattended work — see the cap query in POST
      // /sessions), but they consume a real worker slot, so the global cap
      // still applies.
      const { rows: globalRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions WHERE status IN ('active', 'promoted')`
      );
      if (parseInt(globalRows[0].cnt) >= config.maxGlobalSessions) {
        const { freed } = await sessionLifecycle.freeGlobalSlot({
          pool, graceMs: config.sessionPressureGraceMs,
        });
        if (!freed) {
          return res.status(429).json({ error: 'Platform is at capacity right now. Try again in a few minutes.' });
        }
      }

      const selectedModel = models.resolve(req.body && req.body.model);

      // Full issue text for the seed turn (cache-first; degrades to a
      // number-only seed when GitHub can't be reached right now). The
      // issue's comments ride along (#150) so answers to earlier
      // auto-solve questions are visible to this run; a failed comments
      // fetch degrades to title + body. The bot username lets the seed
      // tag the bot's own earlier question comments.
      const { issue } = await github.fetchPublicIssue(repoOwner, repoName, issueNumber);
      const { comments } = await github.fetchIssueComments(repoOwner, repoName, issueNumber);
      let botUsername = null;
      try { botUsername = await github.getBotUsername(); } catch {}

      const branchName = `dev/auto-issue-${issueNumber}-${Date.now()}`;
      try {
        await github.createBranch(repoOwner, repoName, branchName);
      } catch (err) {
        log.warn('sessions', 'GitHub branch creation failed (continuing)', { err: err.message });
      }

      // #249: deterministic display name — "#N · issue title" — set at
      // creation (no LLM call), so the auto session is named both while
      // generating and after. Null when the issue fetch degraded to
      // number-only; the UI then falls back to the branch name.
      const autoTitle = sessionTitles.headlessTitle(issueNumber, issue && issue.title);

      // linked_issues is seeded with the issue so a PR opened later from a
      // CLONED session carries `Closes #N` (the clone copies the linkage).
      const { rows } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, is_headless, headless_status, headless_issue_number, linked_issues, session_title)
         VALUES ($1, $2, $3, 'active', TRUE, 'generating', $4, $5, $6)
         RETURNING *`,
        [app.id, req.user.id, branchName, issueNumber, [issueNumber], autoTitle]
      );
      const session = rows[0];
      // The runner reuses chat-handler helpers that expect the app fields
      // joined onto the session row.
      session.app_slug = app.slug;
      session.app_name = app.name;
      session.repo_url = app.repo_url;
      session.app_self_hosted = app.self_hosted;

      events.record(pool, {
        type: events.EVENT_TYPES.DEV_SESSION_STARTED,
        userId: req.user.id,
        appId: app.id,
        sessionId: session.id,
        metadata: { headless: true, issueNumber },
      });

      // Fire-and-forget: the run continues after this response. Failures
      // inside the runner mark the row 'failed' (and a platform restart
      // mid-run is swept to 'failed' at boot — see migrate.js).
      runHeadlessSession({
        pool, config, session,
        user: { id: req.user.id, username: req.user.username },
        selectedModel, repoOwner, repoName, userApiKey,
        issueNumber, issue, comments, botUsername,
      }).catch((err) => {
        log.error('sessions', 'Headless session runner crashed', { sessionId: session.id, err: err.message, stack: err.stack });
      });

      log.info('sessions', 'Headless session started', { sessionId: session.id, issueNumber, model: selectedModel });
      res.status(201).json({ session });
    } catch (err) {
      log.error('sessions', 'Failed to start headless session', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // #155: clone a READY headless auto session into the caller's own dev
  // chat. Any collaborator can do this (the sessionCollabGuard above
  // enforces collab access), and many users can clone the same auto
  // session independently — each clone gets its own branch (forked off the
  // auto session's branch so pushed commits carry over), a copy of the
  // chat history + spec, and (best-effort) the auto session's Claude Code
  // memory volume so the agent resumes with full context. A follow-up
  // assistant message tells the new owner where things stand and how to
  // proceed (review spec / answer question / ask for PR + staging).
  router.post('/api/sessions/:id/clone-headless', drainGuard, async (req, res) => {
    try {
      const { rows: srcRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs
         JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.is_headless = TRUE`,
        [req.params.id]
      );
      if (!srcRows.length) return res.status(404).json({ error: 'Auto session not found' });
      const src = srcRows[0];
      if (src.headless_status !== 'ready') {
        return res.status(409).json({
          error: src.headless_status === 'generating'
            ? 'The auto session is still generating — try again when it finishes.'
            : 'This auto session is not in a cloneable state.',
        });
      }

      // The clone is an ordinary dev-chat session, so the usual caps apply.
      // Per-user cap counts only 'active' sessions (#193) — promoted ones
      // are un-pausable while their PR is in a vote, so they're exempt.
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
         WHERE user_id = $1 AND status = 'active' AND is_headless = FALSE`,
        [req.user.id]
      );
      if (parseInt(countRows[0].cnt) >= config.maxUserSessions) {
        return res.status(429).json({ error: `You already have ${config.maxUserSessions} running sessions. Pause or archive one first.` });
      }
      const { rows: globalRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions WHERE status IN ('active', 'promoted')`
      );
      if (parseInt(globalRows[0].cnt) >= config.maxGlobalSessions) {
        const { freed } = await sessionLifecycle.freeGlobalSlot({
          pool, graceMs: config.sessionPressureGraceMs,
        });
        if (!freed) {
          return res.status(429).json({ error: 'Platform is at capacity right now. Try again in a few minutes.' });
        }
      }

      // Fork the new branch off the auto session's branch so any commit it
      // pushed carries over. Fall back to main if that branch is missing
      // (e.g. the headless run never pushed and the branch was pruned).
      const branchName = `dev/${req.user.username}-${Date.now()}`;
      const [, repoOwner, repoName] = (src.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (github.isEnabled() && repoOwner && repoName) {
        try {
          await github.createBranch(repoOwner, repoName, branchName, src.branch_name);
        } catch (err) {
          log.warn('sessions', 'Branch fork off auto session failed — falling back to main', { err: err.message, from: src.branch_name });
          try {
            await github.createBranch(repoOwner, repoName, branchName);
          } catch (err2) {
            log.warn('sessions', 'GitHub branch creation failed (continuing)', { err: err2.message });
          }
        }
      }

      // #249: the clone inherits the auto session's display name.
      // Sources that predate session_title fall back to the same
      // "#N · issue title" derivation (best-effort, cache-first fetch
      // — a failure just leaves the branch-name fallback).
      let cloneTitle = src.session_title || null;
      if (!cloneTitle && src.headless_issue_number && github.isEnabled() && repoOwner && repoName) {
        try {
          const { issue } = await github.fetchPublicIssue(repoOwner, repoName, src.headless_issue_number);
          cloneTitle = sessionTitles.headlessTitle(src.headless_issue_number, issue && issue.title);
        } catch (err) {
          log.warn('sessions', 'Issue fetch for clone title failed (continuing untitled)', { err: err.message });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO chat_sessions (app_id, user_id, branch_name, status, spec_md, linked_issues, testing_md, testing_path, testing_paths, cloned_from_session_id, session_title)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [src.app_id, req.user.id, branchName, src.spec_md || '', src.linked_issues, src.testing_md, src.testing_path,
         src.testing_paths != null ? JSON.stringify(src.testing_paths) : null, src.id, cloneTitle]
      );
      const session = rows[0];

      // Copy the conversation so the Mayor (and the new owner) see the full
      // auto-session context. Costs are zeroed — the cloner didn't pay for
      // the original run and the per-message figures would double-count.
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, model, metadata)
         SELECT $1, role, content, model, metadata
         FROM chat_session_messages WHERE session_id = $2 ORDER BY id ASC`,
        [session.id, src.id]
      );
      // Carry the spec version history too, so the spec viewer shows v1…vN.
      await pool.query(
        `INSERT INTO chat_session_specs (session_id, version, content, built_at, commit_sha, pr_number)
         SELECT $1, version, content, built_at, commit_sha, pr_number
         FROM chat_session_specs WHERE session_id = $2`,
        [session.id, src.id]
      ).catch((err) => log.warn('sessions', 'Spec history copy failed (continuing)', { err: err.message }));

      // Best-effort: clone the auto session's CC memory volume so --resume
      // continues its conversation. On failure the clone simply starts with
      // fresh CC memory (chat history + spec still carry the context).
      if (src.cc_session_id) {
        try {
          await worker.cloneCcVolume(src.id, session.id);
          await pool.query(`UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2`, [src.cc_session_id, session.id]);
          session.cc_session_id = src.cc_session_id;
        } catch (err) {
          log.warn('sessions', 'CC volume clone failed — clone starts with fresh CC memory', { src: src.id, dest: session.id, err: err.message });
        }
      }

      // The promised follow-up (#155): an assistant message telling the new
      // owner where the auto session left off and what to do next.
      //
      // #32: chips render only under the LAST non-system message, which is
      // this follow-up. When the auto session ended in a question, look up
      // the suggestions persisted on its question turn (the source's most
      // recent assistant message with a non-empty metadata.suggestions) and
      // forward them onto the follow-up so the answer chips render under it.
      // spec/code/spec_code outcomes have no questions — they stay chip-free.
      let followUpSuggestions = null;
      if (src.headless_outcome === 'question') {
        const { rows: suggRows } = await pool.query(
          `SELECT metadata FROM chat_session_messages
           WHERE session_id = $1 AND role = 'assistant'
             AND jsonb_array_length(COALESCE(metadata->'suggestions', '[]'::jsonb)) > 0
           ORDER BY id DESC LIMIT 1`,
          [src.id]
        );
        if (suggRows.length) {
          const s = suggRows[0].metadata && suggRows[0].metadata.suggestions;
          if (Array.isArray(s) && s.length) followUpSuggestions = s;
        }
      }
      // #330: spec/code/spec_code clones get static next-step pills (the
      // question path stays pill-free — its answer chips take precedence).
      const followUpQuickReplies = buildHeadlessFollowUpQuickReplies(src);
      const followUp = buildHeadlessFollowUpMessage(src);
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, metadata) VALUES ($1, 'assistant', $2, $3)`,
        [session.id, followUp, JSON.stringify({
          ...(followUpSuggestions ? { suggestions: followUpSuggestions } : {}),
          ...(followUpQuickReplies ? { quickReplies: followUpQuickReplies } : {}),
        })]
      );

      events.record(pool, {
        type: events.EVENT_TYPES.DEV_SESSION_STARTED,
        userId: req.user.id,
        appId: src.app_id,
        sessionId: session.id,
        metadata: { clonedFrom: src.id, headlessIssue: src.headless_issue_number },
      });

      // #161 auto-dismiss: cloning the auto session resolves its
      // completion notification for the cloner. Fire-and-forget;
      // cross-tab badge sync only when something actually cleared.
      notifications.markReadForAction(pool, req.user.id, 'headless_cloned', src.id)
        .then((cleared) => {
          if (cleared > 0) {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          }
        })
        .catch((err) => log.warn('sessions', 'headless_cloned dismiss failed', { err: err.message }));

      log.info('sessions', 'Cloned headless session', { src: src.id, sessionId: session.id, user: req.user.username });
      res.status(201).json({ session });
    } catch (err) {
      log.error('sessions', 'Failed to clone headless session', { message: err.message, stack: err.stack });
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
      // bump just means the next chat turn / open re-marks it. Opening
      // also disarms notify_on_done (#161): the owner is looking at the
      // session again, so a left-mid-turn completion needs no notification.
      pool.query(
        `UPDATE chat_sessions SET last_activity_at = NOW(), notify_on_done = FALSE WHERE id = $1`,
        [req.params.id]
      ).catch((err) => log.warn('sessions', 'activity bump on view failed', { err: err.message }));

      // #161 auto-dismiss: opening the session is the canonical "user saw
      // it" signal — resolve any unread session_done rows for it, even
      // when the user navigated here on their own rather than via the
      // notification. Fire-and-forget; cross-tab badge sync on change.
      notifications.markReadForAction(pool, req.user.id, 'session_opened', rows[0].id)
        .then((cleared) => {
          if (cleared > 0) {
            const { pushNotificationToUser } = require('../services/ws');
            pushNotificationToUser(req.user.id, { type: 'notifications_changed' });
          }
        })
        .catch((err) => log.warn('sessions', 'session_opened dismiss failed', { err: err.message }));

      const { rows: messages } = await pool.query(
        `SELECT id, role, content, model, token_count, cost_cents, metadata, created_at
         FROM chat_session_messages
         WHERE session_id = $1
         ORDER BY id ASC`,
        [req.params.id]
      );

      // #195: attach the session's stored before/after capture ids so the
      // staging card can render its visual tiles on history reload (the
      // live path delivers the same shape via the visuals_ready event).
      // Best-effort — a visuals hiccup must not break opening the session.
      const session = rows[0];
      try {
        session.visuals = await visuals.getForSession(pool, session.id);
      } catch { session.visuals = null; }

      res.json({ session, messages });
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

  // #161: arm/disarm the "notify me when this turn finishes" flag.
  // Owner-only. The client arms it the moment the owner stops watching a
  // running turn (tab hidden, window blurred, tab/app switch, pagehide
  // beacon) and disarms it when they come back mid-run. Idempotent
  // (plain SET), so duplicate fires — e.g. a pagehide beacon racing an
  // earlier visibility-arm — are harmless. Accepts navigator.sendBeacon
  // payloads: a same-origin JSON Blob rides through express.json() and
  // cookie auth applies as usual.
  router.post('/api/sessions/:id/notify-on-done', async (req, res) => {
    try {
      const armed = !!(req.body && req.body.armed);
      const { rowCount } = await pool.query(
        `UPDATE chat_sessions SET notify_on_done = $1
         WHERE id = $2 AND user_id = $3`,
        [armed, req.params.id, req.user.id]
      );
      if (!rowCount) return res.status(404).json({ error: 'Session not found' });
      res.status(204).end();
    } catch (err) {
      log.error('sessions', 'notify-on-done update failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
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

      // Per-user cap counts only 'active' sessions (#193) — promoted ones
      // are un-pausable while their PR is in a vote, so they're exempt.
      // This also keeps the count consistent with the LRU eviction below,
      // which has always only considered 'active' victims.
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
         WHERE user_id = $1 AND status = 'active'`,
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
        runSyncMain(config, pool, sessionId, { trigger: 'resume_autosync' }).catch((err) => {
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

      // #252: a regular chat turn holds the worker — dispatching a sync
      // now would just trip execInWorker's "a turn is already in
      // flight" guard with a raw 500. Surface it as a friendly 409
      // instead. When the in-flight turn IS a sync, fall through:
      // runSyncMain coalesces and this caller joins the running sync.
      if (!syncMainSvc.getSyncState(sessionId)
          && (activeWorkers.has(sessionId) || worker.isInFlight(sessionId))) {
        return res.status(409).json({
          error: 'Claude is still working in this session — wait for the turn to finish before syncing.',
          busy: true,
        });
      }

      const result = await syncMainSvc.runSyncMain(config, pool, sessionId, { sessionRow: session });
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
           AND cs.status IN ('active', 'promoted')
           AND cs.is_headless = FALSE`,
        [req.params.id, req.user.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Active session not found' });
      const session = sessionRows[0];

      // Resolve who pays for this turn once up front (#212): the shared
      // daily allowance is consumed first, and the caller's BYOK key
      // (#30) takes over only after the budget (user or global cap) is
      // exhausted. `userApiKey` therefore reflects the ACTUAL payer for
      // the whole turn — null = platform-billed, non-null = the user's
      // own key — so every recordSpend(..., { byok: !!userApiKey })
      // below routes the cost to the right bucket. Allowance gone and
      // no key on file → the same 429 as always.
      const billing = await limits.resolveBillingPath(pool, config.jwtSecret, req.user.id);
      if (billing.error) return res.status(429).json({ error: billing.error });
      const userApiKey = billing.apiKey;

      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
        [session.id, message.trim()]
      );

      // Mark the session as freshly active so the auto-pause sweeper
      // leaves it alone (see server.js session sweeper + schema
      // last_activity_at). A chat turn is the strongest activity signal.
      // Sending a message also proves presence, so any stale
      // notify-on-done arming from a previous turn is reset (#161).
      await pool.query(
        `UPDATE chat_sessions SET last_activity_at = NOW(), notify_on_done = FALSE WHERE id = $1`,
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
      // 'suggestions' (#32) follows mayor_reasoning's posture: SSE +
      // session bus only — a refresh restores chips from the assistant
      // row's metadata, so the global WS adds nothing but dedup risk.
      const SSE_ONLY = new Set(['token', 'usage', 'error', 'mayor_reasoning', 'suggestions', 'quick_replies']);
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
        // #161: every turn-completion path funnels through send('done')
        // — the main exit, the early returns, and the catch fallthrough —
        // so this is the one hook needed for the left-mid-turn completion
        // notification. Fire-and-forget; the helper swallows its errors.
        if (type === 'done') notifySessionDone(pool, session.id);
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
        // is preserved across stop. During the CC phase the stop signal
        // is worker.stopTurn() (in-container pkill of run-cc.sh +
        // claude); the detached exec has no host-side child to SIGTERM.
        workerName: null,
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

      // #249: first-message naming — a brand-new session (no title yet,
      // no PR) gets a readable display name from its opening ask, long
      // before any code lands. Fire-and-forget: the turn never waits on
      // it, and any failure just keeps the branch-name fallback. The
      // billing path resolved above means the Haiku call is debited to
      // the requesting user (BYOK-aware), like every other turn cost.
      const titledThisTurn = !session.session_title && !session.pr_number;
      if (titledThisTurn) {
        sessionTitles.maybeTitleFirstMessage({
          pool, session, message: message.trim(),
          userId: req.user.id, apiKey: userApiKey, send,
        });
      }
      // #249: pre-PR turn-end refresh — re-title from the full request
      // history + latest spec draft so a vague opening ask sharpens once
      // the direction is clear. Once a PR exists applyPrMetadata owns
      // the name (it mirrors pr_title into session_title), so this
      // never fires again; and the first-message hook already covers
      // the turn it ran on. Fire-and-forget like the hook above.
      const refreshTitleAtTurnEnd = () => {
        if (titledThisTurn || session.pr_number) return;
        sessionTitles.refreshFromHistory({
          pool, session, userId: req.user.id, apiKey: userApiKey, send,
        });
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
        // #199: on the FIRST turn of a fresh session — exactly one user row
        // in the just-loaded history (the message inserted above) and not a
        // headless clone (clones arrive with copied history AND a non-null
        // cloned_from_session_id; headless sessions themselves never reach
        // this route) — surface the app's open promoted/merging proposals so
        // the Mayor can flag a duplicate request before any dispatch.
        // Advisory only: any failure skips the block and the turn proceeds.
        let openProposalsBlock = '';
        const isFirstFreshTurn = !session.cloned_from_session_id
          && history.filter((m) => m.role === 'user').length === 1;
        if (isFirstFreshTurn) {
          try {
            const { rows: proposalRows } = await pool.query(
              `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.status,
                      cs.linked_issues, cs.spec_md, u.username
               FROM chat_sessions cs
               LEFT JOIN users u ON cs.user_id = u.id
               WHERE cs.app_id = $1 AND cs.id <> $2
                 AND cs.status IN ('promoted', 'merging')
               ORDER BY cs.last_activity_at DESC
               LIMIT 10`,
              [session.app_id, session.id]
            );
            openProposalsBlock = buildOpenProposalsBlock(proposalRows, req.user.username);
          } catch (err) {
            log.warn('sessions', 'Open-proposals lookup failed (continuing without block)', { sessionId: session.id, err: err.message });
          }
        }
        let mayorPrompt = getMayorSystemPrompt(session.app_name, isWorkerBusy, currentSpec, !!session.app_self_hosted, prContext, openProposalsBlock);
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
        // The Mayor sees two action tools when no worker is busy:
        // dispatch_scout (all spec drafting AND revision — the Mayor has
        // no in-process spec-edit tools anymore; Claude Code in plan
        // mode does a much better job at spec work, see #111) and
        // dispatch_claude_code (build). Their priority ordering is
        // enforced both by the system prompt AND by the resolution code
        // below — models sometimes ignore prose constraints, so we
        // belt-and-suspenders it server-side.
        // The data tools (list_github_issues / get_github_issue / web_fetch)
        // stay available even when a worker is busy: they're read-only and
        // cheap, and reading the tracker or a linked page while a build runs
        // is a legitimate chat action. The dispatch tools remain gated by
        // isWorkerBusy as before.
        // suggest_answers (#32) rides along in BOTH branches — it's not a
        // dispatch, so asking clarifying questions with tappable answers
        // is fine even while a worker is busy.
        const tools = isWorkerBusy
          ? [SUGGEST_ANSWERS_TOOL, SUGGEST_REPLIES_TOOL, LIST_GITHUB_ISSUES_TOOL, GET_GITHUB_ISSUE_TOOL, WEB_FETCH_TOOL]
          : [DISPATCH_TOOL, DISPATCH_SCOUT_TOOL, SUGGEST_ANSWERS_TOOL, SUGGEST_REPLIES_TOOL, LIST_GITHUB_ISSUES_TOOL, GET_GITHUB_ISSUE_TOOL, WEB_FETCH_TOOL];

        setPhase('mayor1');
        let mayor1;
        // The conversation we feed the Mayor. list_github_issues,
        // get_github_issue, and web_fetch are read-only DATA tools: when the
        // Mayor calls one, we resolve it in-process, append the result as a
        // tool_result, and re-invoke so the Mayor reasons with it in the SAME
        // turn. This loop drains data-calls out BEFORE the terminal-tool
        // (dispatch/spec) selection below, so in the common case
        // mayor1.rawContent carries no dangling data tool_use into phase-2.
        let mayorConvo = messages;
        let dataIters = 0;
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

            const dataCalls = mayor1.toolUses.filter((t) => DATA_TOOL_NAMES.has(t.name));
            // Parallel tool use is enabled, so the Mayor may emit
            // a data tool ALONGSIDE a terminal tool in one response.
            // If a terminal tool is present we must NOT re-invoke here: the
            // re-invocation only answers the data tool_use, leaving the
            // terminal tool_use dangling -> Anthropic 400. Break instead and
            // let the phase-2 wrap-up resolve every tool_use (it already
            // re-fetches any stray data call).
            // suggest_answers (#32) is terminal here too: the turn ends as
            // a question turn, so re-invoking would leave its tool_use
            // dangling in mayorConvo (Anthropic 400). End-of-turn dangling
            // is harmless — buildMayorMessages rebuilds from text rows.
            const hasTerminalTool = mayor1.toolUses.some((t) =>
              t.name === 'dispatch_claude_code'
              || t.name === 'dispatch_scout'
              || t.name === 'suggest_answers'
              || t.name === 'suggest_replies');
            if (!dataCalls.length || hasTerminalTool || dataIters >= MAYOR_DATA_TOOLS_MAX_ITERS) break;
            dataIters += 1;

            // Bill each intermediate data-tool turn — the Anthropic call
            // happened and is invoiced whether or not it produced text.
            // (The final iteration's spend is billed by the existing
            // phase-1 accounting just below the loop.)
            let dataCost = 0;
            if (mayor1.usage) {
              dataCost = llm.estimateCostCents(mayor1.usage, selectedModel);
              await limits.recordSpend(pool, req.user.id, dataCost, { byok: !!userApiKey });
              send('usage', { costCents: dataCost, model: selectedModel, byok: !!userApiKey });
            }

            // Persist any preamble text this iteration produced ("Let me
            // check the open issues…") as its own assistant row BEFORE the
            // status row — chat_session_messages id order is the
            // refresh-render order, and without this row the preamble
            // bubble would vanish on refresh. mayor_reasoning makes the
            // live bubble authoritative even if token events were lost.
            if (mayor1.text.trim()) {
              send('mayor_reasoning', { text: mayor1.text });
              await pool.query(
                `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents)
                 VALUES ($1, 'assistant', $2, $3, $4, $5)`,
                [session.id, mayor1.text, selectedModel,
                  mayor1.usage ? mayor1.usage.input_tokens + mayor1.usage.output_tokens : null,
                  dataCost]
              );
            }
            // Seal the bubble so the next iteration's tokens land in a
            // fresh one BELOW the status line (#99) — without this the
            // follow-up text appends to the bubble above the status.
            send('assistant_message_end', {});

            await sendStatus(dataToolStatusLine(dataCalls));
            const dataResults = await Promise.all(
              dataCalls.map((tc) => resolveDataToolResult(tc, repoOwner, repoName))
            );
            mayorConvo = [
              ...mayorConvo,
              // Verbatim assistant content (incl. the tool_use blocks) so the
              // tool_result ids resolve, exactly like the phase-2 round-trip.
              { role: 'assistant', content: mayor1.rawContent },
              {
                role: 'user',
                content: dataCalls.map((tc, i) => ({
                  type: 'tool_result',
                  tool_use_id: tc.id,
                  content: dataResults[i],
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
        // Strip unconditionally (#358): the marker is only ever produced by
        // the harness (buildMayorMessages); an assistant turn must never
        // carry it, whether or not a tool was also called. When the scrub
        // empties the text, substitute an honest note.
        {
          const stripped = stripFakeCompletionMarker(mayorText1, { sessionId: session.id });
          if (stripped !== mayorText1) {
            mayorText1 = stripped
              || '(I described what should change, but didn\'t actually run the coding agent — try sending again.)';
          }
        }

        // Q/A mode (#32): suggested answers for clarifying questions.
        // Dropped when a dispatch tool co-occurred (clarity gate forbids
        // ask+dispatch — dispatch wins); skipped entirely when there is
        // no assistant text to attach them to.
        const { suggestions, droppedForDispatch } = resolveSuggestedAnswers(mayor1.toolUses);
        if (droppedForDispatch) {
          log.warn('sessions', 'Mayor emitted suggest_answers alongside a dispatch tool — dropping suggestions', {
            sessionId: session.id,
          });
        }
        // Quick-reply pills (#285): dropped when a dispatch (regenerated in
        // phase-2 post-build) or suggest_answers (inline chips win) co-occurs.
        const quickReplies = resolveQuickReplies(mayor1.toolUses);

        // Always debit the Mayor's phase-1 spend — even on tool-only
        // turns where mayorText1 is empty (the Anthropic call still
        // happened and was billed). chat_session_messages still gets
        // an assistant row only when there's actual reasoning text;
        // an empty assistant message would clutter the chat history.
        const costCents1 = mayor1.usage ? llm.estimateCostCents(mayor1.usage, selectedModel) : 0;
        if (mayorText1.trim()) {
          send('mayor_reasoning', { text: mayorText1 });
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents, metadata)
             VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
            [session.id, mayorText1, selectedModel, mayor1.usage.input_tokens + mayor1.usage.output_tokens, costCents1,
             JSON.stringify({ ...(suggestions ? { suggestions } : {}), ...(quickReplies ? { quickReplies } : {}) })]
          );
          if (suggestions) send('suggestions', { suggestions });
          if (quickReplies) send('quick_replies', { replies: quickReplies });
        }
        // BYOK users pay Anthropic directly, so their spend lands in
        // the display-only byok_cost_cents bucket (#119) — only
        // platform-key spend counts against the daily caps.
        if (mayor1.usage) {
          await limits.recordSpend(pool, req.user.id, costCents1, { byok: !!userApiKey });
          send('usage', { costCents: costCents1, model: selectedModel, byok: !!userApiKey });
        }

        // Pick which tool the Mayor invoked, with server-side priority
        // enforcement: dispatch_scout > dispatch_claude_code. If the
        // Mayor (mis)used both in one turn, we honor the planning tool
        // and quietly drop the dispatch — same rule the tool
        // descriptions state, but enforced here so a model regression
        // can't cause a surprise build mid-spec-discussion.
        const scoutCall = mayor1.toolUses.find((t) => t.name === 'dispatch_scout');
        const dispatchCall = mayor1.toolUses.find((t) => t.name === 'dispatch_claude_code');

        let activeToolCall = null;
        let toolKind = null; // 'scout' | 'build'
        if (scoutCall) { activeToolCall = scoutCall; toolKind = 'scout'; }
        else if (dispatchCall) { activeToolCall = dispatchCall; toolKind = 'build'; }

        if (!activeToolCall) {
          // Pure chat turn — no tool call needed.
          refreshTitleAtTurnEnd();
          send('done', {});
          res.end();
          setTimeout(() => sessionBus.clearSession(session.id), 30000);
          return;
        }

        // Race check: scout and build both share a per-session worker
        // container, so they share the same gate.
        //
        // Same warm-CC caveat as /status and isWorkerBusy above —
        // gating on container-status would reject every scout/build
        // for ~10 min after the first dispatch finishes (warm idle is
        // not busy).
        if (activeWorkers.has(session.id) || worker.isInFlight(session.id)) {
          await sendStatus('Claude Code is already running for this session. Please wait for it to finish.');
          send('done', {});
          res.end();
          return;
        }

        // Seal the phase-1 assistant bubble so the phase-2 wrap-up
        // lands in a fresh bubble below the CC status/progress events.
        send('assistant_message_end', {});

        // Persist any GitHub issues the Mayor declared this dispatch
        // addresses (#75). Union with the session's existing linkage so the
        // set grows across turns; pr-metadata.js turns each number into a
        // `Closes #N` line in the PR body. Best-effort: a failure here
        // must not block the build.
        {
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
        if (toolKind === 'scout') {
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
        // data-tool round-trips resolved above stay in context for
        // the wrap-up. Answer EVERY tool_use in the final assistant turn —
        // not just the terminal one we ran: if the Mayor combined a
        // data call with a terminal tool (or hit the data-tool
        // loop cap), a leftover tool_use would otherwise dangle and Anthropic
        // would 400 the wrap-up. The terminal tool gets the real result; any
        // stray data call gets a fresh fetch (re-fetching is acceptable);
        // anything else gets a benign skip note.
        const phase2ToolResults = [];
        for (const tu of mayor1.toolUses) {
          if (tu.id === activeToolCall.id) {
            phase2ToolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: toolResult.toolResultText,
              ...(toolResult.isError ? { is_error: true } : {}),
            });
          } else if (DATA_TOOL_NAMES.has(tu.name)) {
            phase2ToolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: await resolveDataToolResult(tu, repoOwner, repoName),
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
        // Re-read spec_md and rebuild the system prompt: a scout may
        // have just mutated it, and the wrap-up turn should describe
        // the doc as it is now (not as it was at the start of phase-1).
        currentSpec = await loadSessionSpec(pool, session.id);
        // Recompute PR context: a dispatch this turn may have just opened
        // a PR (applyPrMetadata mutates session.pr_number in place).
        const prContext2 = session.pr_number
          ? { prNumber: session.pr_number, prTitle: session.pr_title, status: session.status }
          : null;
        // Same open-proposals block as phase-1 so the wrap-up turn sees a
        // consistent prompt (the instruction is scoped to "before
        // dispatching", so it's inert after a tool has already run).
        mayorPrompt = getMayorSystemPrompt(session.app_name, isWorkerBusy, currentSpec, !!session.app_self_hosted, prContext2, openProposalsBlock);
        const mayor2 = await llm.streamChat({
          messages: followUpMessages,
          systemPrompt: mayorPrompt,
          model: selectedModel,
          // Expose ONLY the quick-reply pills tool (#285) so the wrap-up can
          // suggest next steps but cannot dispatch again — the dispatch tools
          // are simply absent from the list, preserving the original
          // "wrap-up can't dispatch" invariant that toolChoice:none gave us.
          tools: [SUGGEST_REPLIES_TOOL],
          toolChoice: { type: 'auto' },
          onToken: (text) => send('token', { text }),
          apiKey: userApiKey,
        });

        // Quick-reply pills (#285): the wrap-up reflects the final post-build
        // state, so this is where dispatch turns get their pills. The
        // tool_use is terminal (end of turn) — no tool_result round-trip.
        const quickReplies2 = resolveQuickReplies(mayor2.toolUses);

        let mayorText2 = stripFakeCompletionMarker(mayor2.text, { sessionId: session.id });
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
            mayorText2 = toolKind === 'scout'
              ? "_The scout didn't finish successfully — see the status above._"
              : "_The coding agent didn't complete successfully — see the status messages above._";
          } else if (toolKind === 'scout') {
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
          `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents, metadata)
           VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
          [session.id, mayorText2, selectedModel, mayor2.usage.input_tokens + mayor2.usage.output_tokens, costCents2,
           JSON.stringify(quickReplies2 ? { quickReplies: quickReplies2 } : {})]
        );
        if (quickReplies2) send('quick_replies', { replies: quickReplies2 });
        await limits.recordSpend(pool, req.user.id, costCents2, { byok: !!userApiKey });
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

      // #249: covers every turn that reached the main exit without a PR
      // — no-changes turns, scout/spec turns, errored dispatches. PR
      // turns skip it (applyPrMetadata mirrored the title already).
      refreshTitleAtTurnEnd();
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
  // by the Mayor's dispatch_scout) and an append-only history of
  // immutable numbered versions in chat_session_specs.
  // A version is frozen on every spec mutation (#27, via
  // snapshotSessionSpec), so spec_md is always byte-identical to the
  // latest version. Numbered versions (v1…vN) are the single spec
  // surface the dev-chat viewer presents (#69 removed the separate
  // "Draft (live)" entry and the manual "Save version" step); spec_md
  // is kept purely as the live-draft buffer the scout revises against
  // and as a theme signal for PR metadata. The dev-chat UI surfaces the spec
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
  //   - (#86) A user the owner privately shared this exact version with
  //     via POST /specs/:version/share-user — the
  //     chat_session_spec_user_shares row is the authorization source
  //     of truth, scoped to (session, version, recipient).
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
           AND (cs.user_id = $3 OR s.shared_to_group_at IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM chat_session_spec_user_shares us
                   WHERE us.session_id = s.session_id
                     AND us.version = s.version
                     AND us.recipient_id = $3
                ))`,
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
  // was retired. Every Mayor spec mutation (scout) already
  // auto-freezes an immutable numbered version via
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

  // (#86) Privately share a frozen spec version with ONE user. Unlike
  // the group share above, nothing is posted to chat and the spec is
  // NOT marked shared_to_group_at — the recipient gets a 'spec_shared'
  // notification that deep-links into the read-only spec panel, and the
  // chat_session_spec_user_shares row widens the GET /specs/:version
  // gate for exactly (session, version, recipient). Repeatable: the
  // owner can share with several people one at a time; re-sharing with
  // the same person is an idempotent no-op (no second notification).
  router.post('/api/sessions/:id/specs/:version/share-user', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const version = parseInt(req.params.version, 10);
    if (Number.isNaN(sessionId) || Number.isNaN(version)) {
      return res.status(400).json({ error: 'Bad id/version' });
    }
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (!username) return res.status(400).json({ error: 'Username required' });

    try {
      // Owner-only, same as the group-share route.
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.app_id
         FROM chat_sessions cs
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [sessionId, req.user.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Session not found' });
      const appId = sessionRows[0].app_id;

      const { rows: specRows } = await pool.query(
        `SELECT version FROM chat_session_specs
         WHERE session_id = $1 AND version = $2`,
        [sessionId, version]
      );
      if (!specRows.length) return res.status(404).json({ error: 'Spec version not found' });

      const users = await notifications.resolveUsers(pool, [username.toLowerCase()]);
      if (!users.length) return res.status(404).json({ error: 'User not found' });
      const recipient = users[0];
      if (recipient.id === req.user.id) {
        return res.status(400).json({ error: 'You already have this spec' });
      }

      // Collab-private apps: a share must not grant a non-member a spec
      // they'd have no app context for. Explicit error (not a silent
      // drop) — the sharer needs the feedback.
      const allowed = await notifications.filterToCollaborators(pool, appId, [recipient.id]);
      if (!allowed.includes(recipient.id)) {
        return res.status(400).json({ error: "That user doesn't have access to this app" });
      }

      const { rowCount } = await pool.query(
        `INSERT INTO chat_session_spec_user_shares (session_id, version, recipient_id, shared_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id, version, recipient_id) DO NOTHING`,
        [sessionId, version, recipient.id, req.user.id]
      );
      if (rowCount === 0) {
        // Already shared with this person — re-shares must not re-ping.
        return res.json({ ok: true, alreadyShared: true, recipient: { username: recipient.username } });
      }

      const rows = await notifications.createSpecSharedNotification(pool, {
        recipientId: recipient.id,
        appId,
        sessionId,
        sharerId: req.user.id,
        version,
      });
      for (const row of rows) await notifications.hydrateAndPush(pool, row);

      res.json({ ok: true, recipient: { username: recipient.username } });
    } catch (err) {
      log.error('sessions', 'Share spec to user failed', { message: err.message });
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

    // Experimental AI progress estimate: latest in-memory Haiku guess for
    // the run, so the 3s polling fallback carries it when SSE/WS drop.
    // Null whenever the per-user toggle is off or no estimate exists yet.
    const estimate = workerProgress.get(sessionId)?.estimate || null;

    // #239: whether the auto-conflict-resolver currently has a resolve
    // in flight for this session. The client's "resolving merge
    // conflicts" banner polls this as its reload-recovery and
    // missed-WS-event safety net.
    const { isResolving } = require('../services/conflict-resolver');

    // #252: in-flight sync-with-main state ({ phase, startedAt } |
    // null) — the dev-chat sync banner's reload recovery and poll
    // fallback read this the same way the resolving banner reads
    // `resolving`.
    // Keys: busy, progress, phase, estimate (+ resolving, sync). `estimate`
    // is { text, remainingSeconds } | null — see workerProgress.setEstimate.
    res.json({
      busy, progress, phase, estimate,
      resolving: isResolving(sessionId),
      sync: syncMainSvc.getSyncState(sessionId),
    });
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
    // #161: clicking stop proves presence — disarm notify_on_done BEFORE
    // aborting so the turn's resulting send('done') doesn't create a
    // spurious "your session finished" notification.
    await pool.query(
      `UPDATE chat_sessions SET notify_on_done = FALSE WHERE id = $1`,
      [sessionId]
    ).catch((err) => log.warn('sessions', 'stop disarm failed', { sessionId, err: err.message }));
    log.info('sessions', 'Stop requested', {
      sessionId,
      phase: handle.phase,
      by: req.user.username,
      ccRunning: handle.phase === 'cc',
      hasWorker: !!handle.workerName,
    });

    if (handle.phase === 'cc') {
      // Detached-turn path: the CC turn runs as a detached exec with no
      // host-side child to signal, so kill run-cc.sh + claude inside
      // the container directly. The warm wrapper (sleep infinity)
      // survives, keeping the next dispatch fast. The journal consumer
      // notices the process is gone via its liveness watchdog and
      // resolves, letting runClaudeCodeTool's early-return branch fire.
      worker.stopTurn(sessionId)
        .catch((err) => log.warn('sessions', 'stopTurn failed', { err: err.message }));
    } else if (handle.workerName) {
      // Legacy single-shot fallback: no in-flight turn to signal, so we
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
      // #119: spend billed to the user's own Anthropic key today —
      // informational only, never part of the cap math above.
      const { rows: byokRows } = await pool.query(
        'SELECT byok_cost_cents FROM llm_usage WHERE user_id = $1 AND date = CURRENT_DATE',
        [req.user.id]
      );
      const byokSpentCents = parseFloat(byokRows[0]?.byok_cost_cents || 0);
      // #297: surface AI availability so client chrome (the proposal
      // "Ask AI" button) can disable itself with a tooltip when there's
      // no usable LLM path — the platform key is unset AND the user has
      // no BYOK key on file. Same degradation posture the dev chat takes.
      const userApiKey = await limits.loadUserApiKey(pool, req.user.id, config.jwtSecret);
      res.json({
        spentCents: userSpent,
        limitCents: userLimit,
        globalSpentCents: globalSpent,
        globalLimitCents: globalLimit,
        byokSpentCents,
        aiEnabled: llm.isEnabled() || !!userApiKey,
      });
    } catch (err) {
      log.error('sessions', 'Budget check failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Deploy staging for a session
  router.post('/api/sessions/:id/deploy-staging', drainGuard, async (req, res) => {
    try {
      // #183: headless rows are excluded — their staging is built by the
      // headless runner itself; humans deploy staging from a CLONED session.
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url, a.id as app_id_val
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status IN ('active', 'promoted')
           AND cs.is_headless = FALSE`,
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

// The BYOK key lookup that used to live here (loadUserApiKey) moved to
// services/limits.js (#212) — every call site now goes through
// limits.resolveBillingPath, which consumes the daily allowance first
// and only reaches for the key once the budget is exhausted.

// #155: the follow-up assistant message appended to a session cloned from a
// headless auto session — tells the new owner where the auto run left off
// (spec to review / code done / question pending) and that PR + staging are
// theirs to trigger.
function buildHeadlessFollowUpMessage(src) {
  const n = src.headless_issue_number;
  const issueRef = n ? `GitHub issue #${n}` : 'a GitHub issue';
  const intro =
    `This session was cloned from an auto session that ran unattended on ${issueRef}. `
    + `You're on your own branch (forked from the auto session's, so its commits carry over) — `
    + `other users can clone the same auto session independently without affecting yours.`;
  switch (src.headless_outcome) {
    case 'spec':
      return `${intro}\n\nWhere things stand: the auto session investigated the repo and drafted a spec — open the spec viewer to review it. When you're happy with it, tell me to build it and I'll dispatch the coding agent (that turn also opens the PR and staging preview).`;
    case 'code':
      return `${intro}\n\nWhere things stand: the code change is already committed and pushed on this branch — see the "Changes ready" card above. A staging preview may be shown there ("Preview staging" / "Test this change") if one built; if it didn't, the card still lets you propose and the preview is rebuilt then. No PR exists yet. Review the change, iterate if you want, and when you're ready hit "Propose to group" on the card — that opens the PR on this branch and starts the vote (or just ask me).`;
    case 'spec_code':
      return `${intro}\n\nWhere things stand: the auto session drafted a spec (open the spec viewer to review it) AND implemented it — the change is committed and pushed on this branch. See the "Changes ready" card above; a staging preview may be shown there if one built, and either way the card lets you propose (the preview is rebuilt at propose time if needed). No PR exists yet. Review the spec and the change, iterate if you want, and when you're ready hit "Propose to group" on the card — that opens the PR on this branch and starts the vote (or just ask me).`;
    default:
      return `${intro}\n\nWhere things stand: the auto session ran into something that needs a human decision — see its last message above (the same questions were also posted as a comment on the GitHub issue). Answer here and we'll continue from where it left off.${(src.spec_md || '').trim() ? ' The auto session also drafted a spec — open the spec viewer to review it alongside the questions.' : ''}`;
  }
}

// #330: next-step quick-reply pills for the cloned follow-up message. The
// auto-session clone produces no Mayor turn, so the follow-up would
// otherwise land with an empty pill bar — leaving the user told to "build
// it" with nothing to tap. Attach static, outcome-appropriate pills so the
// above-box pill row is populated from the first screen. The 'question'
// outcome returns null: it already forwards the question turn's answer
// chips, and pills are mutually exclusive with chips (answers win). Routed
// through sanitizeQuickReplies to keep the ≤3 / ≤80-char invariant shared
// with the Mayor's suggest_replies path.
function buildHeadlessFollowUpQuickReplies(src) {
  let replies;
  switch (src.headless_outcome) {
    case 'spec':
      replies = ['Build it', 'Revise the spec', 'What will this change?'];
      break;
    case 'code':
      replies = ['Propose it to the group', 'Make a tweak', 'What did it change?'];
      break;
    case 'spec_code':
      replies = ['Propose it to the group', 'Revise the spec', 'Make a tweak'];
      break;
    default:
      return null;
  }
  return sanitizeQuickReplies({ replies });
}

// The unattended-mode addendum appended to the Mayor system prompt for
// both headless phases. Factored out so the boot-time resume path
// (resumeHeadlessRuns) can rebuild the exact same prompt.
function buildHeadlessAddendum(issueNumber) {
  return `

HEADLESS AUTO-SESSION MODE: you are running unattended on GitHub issue #${issueNumber} — there is NO human in this chat and there will be NO follow-up turn. Decide ONE action for this single turn, in this order:
1. FIRST apply the CLARITY GATE (above) to the issue, including any ISSUE COMMENTS included in the message — treat the reporter's comments as their input, and comments marked as earlier proposal questions as your own previous turn (answers to them may make the issue clear now). If the issue FAILS the gate, classify each blocking question you would ask:
   - REPO-ANSWERABLE: what exists in the app, where the relevant code lives, how a feature currently behaves, whether the report matches reality. Asking the reporter is a last resort — investigation comes first: these questions go to dispatch_scout (step 2), NOT to the reporter. In the scout prompt, enumerate the unresolved points and instruct it to settle them from the code, choose stated defaults where reasonable, and keep only the genuinely human-only blockers in a "Questions" section.
   - HUMAN-ONLY: what the reporter wants, product/priority choices, reproduction details only the reporter has — things no codebase can answer.
   ONLY if EVERY blocking question is human-only: reply in plain text containing ONLY the numbered clarifying questions with your suggested defaults, AND ALSO call suggest_answers for those questions. The suggest_answers call is metadata-only — it does NOT change the verbatim text posted to GitHub issue #${issueNumber}; it exists so the human who later starts a session from this proposal can tap the suggested answers. The visible text must still be ONLY the numbered questions with defaults. Your text reply will be posted verbatim as a comment on GitHub issue #${issueNumber} for the reporter to answer — write it for them (no greetings, no meta-talk about sessions or tools). Otherwise dispatch_scout per step 2.
2. dispatch_scout when the issue passes the gate and needs investigation or design — OR when the gate failed for repo-answerable reasons (scouting is also the way to resolve ambiguity): produce a grounded spec a human will review later. Prefer this for anything non-trivial. After the scout returns you will get ONE follow-up decision turn where you may implement the spec immediately if it turned out straightforward — so scouting first never costs you the chance to ship; any questions surviving the scout's investigation will be posted to the issue from that decision turn, so failing the gate is not a reason to avoid scouting.
3. dispatch_claude_code ONLY for small, unambiguous fixes the issue text fully specifies. The agent may commit and push its branch, and a staging preview is built from the pushed commit — but NO pull request is created in this mode; a human will start a session from this auto session later and propose the change (which opens the PR on their branch).
Never promise future work and never ask for confirmation — state what you did and what the human reviewer should do next.`;
}

// #170: the addendum for the headless DECISION turn — the one extra Mayor
// call offered after a successful scout, where the run may proceed straight
// into implementation if (and only if) the spec is straightforward. The
// criteria live here in prompt text so they're tunable without flow
// changes; the hard limits (one build max, budget re-check, no PR/staging)
// are enforced in code in runHeadlessSession.
function buildHeadlessDecisionAddendum(issueNumber) {
  return `

DECISION TURN: the scout's spec is now in your system prompt (CURRENT SPEC DOC). You get exactly ONE more action.
If the spec contains a Questions section with decisions a human must make: do NOT dispatch. Reply in plain text containing ONLY those numbered questions with your suggested defaults, written for the issue reporter, AND ALSO call suggest_answers for those questions. The suggest_answers call is metadata-only — it does NOT change the verbatim text posted to GitHub issue #${issueNumber}; it exists so the human who later starts a session from this proposal can tap the suggested answers. The visible text must still be ONLY the numbered questions with defaults. Your text reply will be posted verbatim as a comment on GitHub issue #${issueNumber} (no greetings, no meta-talk about sessions or specs).
Otherwise, dispatch dispatch_claude_code to implement the spec NOW only if ALL of these hold:
- The spec has no **unresolved/blocking** questions — a "Questions" section that says "None" (or is empty) is NOT a blocker; proceed to build it. Only an open question that genuinely requires a human decision blocks the build.
- It describes a small, bounded change with concrete file paths — roughly a handful of files, no broad refactor.
- Database schema changes are allowed ONLY when they are append-only and forward-only: creating new tables (\`CREATE TABLE IF NOT EXISTS\`), adding new nullable columns (\`ADD COLUMN IF NOT EXISTS\`), and forward-only data backfills. Drops, renames, type changes, not-null tightenings, and any other destructive or irreversible database operation are NOT allowed — defer to a human when in doubt. Also no other destructive or irreversible operations, and no changes to auth, billing, permissions, or security-sensitive code.
- No new external services, dependencies, or credentials.
- The spec stays within what issue #${issueNumber} asked for (no scope expansion).
If ANY criterion fails or you are unsure, reply in plain text instead — summarize the spec and stop; a human will review it. When you do dispatch, the prompt must tell the agent to implement the session's spec doc exactly as written and not redesign it. Remember: headless mode means commit + push + staging preview — no PR.`;
}

// #150: build the headless run's seed user message from the issue plus
// its comments, so answers the reporter left as comments are visible to
// the run. Comments authored by the platform bot are tagged so the Mayor
// recognizes its own earlier clarifying questions vs. the reporter's
// answers. Each comment body is truncated and only the most recent
// HEADLESS_SEED_MAX_COMMENTS are kept (with an omission marker), so a
// chatty thread can't blow up the model's context. Exported for tests.
const HEADLESS_SEED_MAX_COMMENTS = 20;
const HEADLESS_SEED_COMMENT_MAX_CHARS = 2000;
function buildHeadlessSeed(issueNumber, issue, comments, botUsername) {
  const title = issue ? issue.title : '';
  const body = issue && issue.body ? `\n\n${issue.body}` : '';
  let seed = `Please work on GitHub issue #${issueNumber}: "${title}".${body}`;

  const list = Array.isArray(comments) ? comments : [];
  if (!list.length) return seed;

  const kept = list.slice(-HEADLESS_SEED_MAX_COMMENTS);
  const lines = kept.map((c) => {
    const author = (c.author || 'unknown').toString();
    // GitHub App actors comment as `<name>[bot]`; tolerate that suffix.
    const isBot = !!botUsername
      && author.toLowerCase().replace(/\[bot\]$/, '') === botUsername.toLowerCase();
    const date = (c.createdAt || '').slice(0, 10);
    const tag = isBot
      ? `[bot — earlier proposal questions${date ? `, ${date}` : ''}]`
      : `[${author}${date ? `, ${date}` : ''}]`;
    let text = (c.body || '').toString();
    if (text.length > HEADLESS_SEED_COMMENT_MAX_CHARS) {
      text = `${text.slice(0, HEADLESS_SEED_COMMENT_MAX_CHARS)}… [truncated]`;
    }
    return `${tag} ${text}`;
  });
  if (list.length > kept.length) lines.unshift('[earlier comments omitted]');

  seed += `\n\nISSUE COMMENTS (oldest first):\n${lines.join('\n\n')}`;
  return seed;
}

// #150: gate for posting phase-1 question text back to the GitHub issue.
// Only a PURE-TEXT phase-1 turn qualifies: the dispatch-error path also
// ends outcome='question' but its text is an error summary, not
// questions for the reporter. Exported for tests.
function shouldPostHeadlessQuestionComment({ outcome, dispatchedTool, mayorText }) {
  return outcome === 'question' && !dispatchedTool && !!(mayorText || '').trim();
}

// #178/#196: does the spec still carry a blocking "Questions" section after
// the scout's investigation? Keys on ATX headings whose text begins with
// "Question(s)" / "Open question(s)" — the exact section name the base
// prompt and scout prompt mandate for blockers — then INSPECTS the section
// body: a heading whose body is empty or only a "nothing here" marker
// ("None", "N/A", …) is NOT a blocker, so a scout's habitual
// "### Questions\nNone" no longer parks the run for a human. Only a section
// with real residual content (a list item or sentence) blocks. A false
// positive merely downgrades a buildable spec to a posted-questions
// round-trip; a false negative reproduces the old park-for-human behavior.
// Exported for tests.
//
// Recognized "nothing here" markers (case-insensitive, tolerating trailing
// punctuation and a short trailing clause like "None — resolved from code.").
const QUESTIONS_EMPTY_MARKER_RE = /^(?:none|n\/a|na|no\s+open\s+questions|no\s+questions|no\s+blocking\s+questions|none\s+blocking|nothing\s+blocking)\b/i;

function specHasBlockingQuestions(specMd) {
  const text = specMd || '';
  // Match a Questions-style ATX heading, capturing its level (# count) so we
  // can find where its section ends (next same-or-higher-level heading).
  const headingRe = /^(#{1,6})\s*(?:open\s+)?questions?\b[^\n]*$/gim;
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    const level = m[1].length;
    const bodyStart = m.index + m[0].length;
    // Find the next heading whose level is <= this section's level (a sibling
    // or higher heading); deeper sub-headings stay part of the section.
    const rest = text.slice(bodyStart);
    const stopRe = /^(#{1,6})\s/gm;
    let stop;
    let bodyEnd = rest.length;
    while ((stop = stopRe.exec(rest)) !== null) {
      if (stop[1].length <= level) { bodyEnd = stop.index; break; }
    }
    const body = rest.slice(0, bodyEnd);
    if (questionsBodyHasContent(body)) return true;
  }
  return false;
}

// Strip markdown noise from a Questions section body and decide whether it
// carries a real question (vs. empty or a "None"-style marker).
function questionsBodyHasContent(body) {
  const cleaned = (body || '')
    .split('\n')
    .map((line) => line
      // drop leading list/quote markers
      .replace(/^\s*(?:[-*>]\s*)+/, '')
      // drop emphasis underscores/asterisks anywhere
      .replace(/[_*]/g, '')
      .trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim();
  if (!cleaned) return false;
  if (QUESTIONS_EMPTY_MARKER_RE.test(cleaned)) return false;
  return true;
}

const HEADLESS_QUESTION_FOOTER = '\n\n— Posted by this issue\'s proposal session. '
  + 'Answer in a comment (or edit the issue body), then press **Generate proposal** on the issue again — the next run reads the answers.';

// Best-effort: a failed post must never fail or change the run's outcome
// (the parked session remains the fallback channel). Returns whether the
// comment landed so the caller can decide whether to surface a status.
async function postHeadlessQuestionComment({ repoOwner, repoName, issueNumber, questionText }) {
  try {
    await github.createIssueComment(repoOwner, repoName, issueNumber, questionText + HEADLESS_QUESTION_FOOTER);
    return true;
  } catch (err) {
    log.warn('sessions', 'Failed to post clarifying questions to issue (continuing)', {
      issueNumber, err: err.message,
    });
    return false;
  }
}

// Persist where the headless loop currently is so a platform restart can
// resume from the last checkpoint instead of failing the run. Steps:
// 'planning' (Mayor phase-1) → 'cc_running' (CC turn dispatched) →
// 'wrapping' (Mayor phase-2). `outcome` is persisted alongside the
// cc_running → wrapping transition so a 'wrapping' resume knows what the
// dispatch arrived at without re-deriving it.
async function setHeadlessStep(pool, sessionId, step, outcome) {
  await pool.query(
    outcome !== undefined
      ? 'UPDATE chat_sessions SET headless_step = $1, headless_outcome = $3 WHERE id = $2'
      : 'UPDATE chat_sessions SET headless_step = $1 WHERE id = $2',
    outcome !== undefined ? [step, sessionId, outcome] : [step, sessionId]
  ).catch((err) => {
    log.warn('sessions', 'Failed to persist headless_step', { sessionId, step, err: err.message });
  });
}

// #155: the unattended Mayor turn behind the issue panel's "Generate
// proposal" button. Mirrors one POST /chat turn (phase-1 Mayor + optional dispatch +
// phase-2 wrap-up) with three deliberate differences: there is no SSE
// stream (events go to the session bus / global WS only), there is no stop
// handle (nobody is watching), and a build dispatch runs with
// `headless: true` so it can push its branch and build a staging preview
// (#183) but never opens a PR. All spend is billed to the clicking user. On success the
// session flips to headless_status='ready' with an outcome of 'spec'
// (scout drafted a spec), 'code' (commit pushed), 'spec_code' (#170 — scout
// drafted a spec AND the decision turn implemented it), or 'question' (the
// Mayor replied in text / the dispatch errored — either way a human needs
// to look).
//
// #170: after a SUCCESSFUL scout, phase-2 becomes a DECISION turn — the
// Mayor sees the spec in its system prompt and may dispatch one (and only
// one) headless build when the spec is straightforward, followed by a
// tool-less phase-3 wrap-up. Every other path keeps the original tool-less
// phase-2 wrap-up.
//
// `resume` is set by resumeHeadlessRuns when re-driving a 'planning'-step
// run after a restart: the seed user message already exists in
// chat_session_messages, so it isn't inserted again.
async function runHeadlessSession({
  pool, config, session, user, selectedModel,
  repoOwner, repoName, userApiKey, issueNumber, issue,
  comments = [], botUsername = null,
  resume = false,
}) {
  const { broadcastGlobal } = require('../services/ws');
  const seqPrefix = `h${Date.now().toString(36)}`;
  let eventSeq = 0;
  const send = (type, data) => {
    const event = { type, _seq: `${seqPrefix}-${++eventSeq}`, ...data };
    broadcastGlobal({ type: 'session_event', sessionId: session.id, event: type, ...event });
    sessionBus.publish(session.id, event);
  };
  const sendStatus = async (text, metadata) => {
    send('status', { text, ...(metadata || {}) });
    await pool.query(
      `INSERT INTO chat_session_messages (session_id, role, content, metadata)
       VALUES ($1, 'system', $2, $3)`,
      [session.id, text, JSON.stringify(metadata || {})]
    ).catch(() => {});
  };
  // The dispatch helpers (runScoutTool / runClaudeCodeTool) use `req` only
  // for billing identity (+ PR author, unused in headless) and `res` only
  // for SSE heartbeats — substitute the clicking user and a write-sink.
  const fakeReq = { user: { id: user.id, username: user.username } };
  const fakeRes = { write() {} };

  const debitMayorUsage = async (usage) => {
    if (!usage) return;
    const cost = llm.estimateCostCents(usage, selectedModel);
    await limits.recordSpend(pool, user.id, cost, { byok: !!userApiKey });
    send('usage', { costCents: cost, model: selectedModel, byok: !!userApiKey });
    return cost;
  };

  let outcome = 'question';
  // #178: the reporter-facing question text to post on the issue at the
  // terminal write, set by whichever path produced it — the phase-1
  // pure-text turn, or the decision turn when the scout's spec still
  // carries a blocking Questions section. Empty means nothing to post.
  let questionTextToPost = '';
  try {
    // Seed turn: same shape as the issue panel's "Create PR" seeding, minus
    // the open-a-PR instruction (headless mode never opens one), plus the
    // issue's comments (#150) so answers to earlier clarifying questions
    // are visible to this run.
    const seed = buildHeadlessSeed(issueNumber, issue, comments, botUsername);
    if (!resume) {
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
        [session.id, seed]
      );
    }
    await setHeadlessStep(pool, session.id, 'planning');
    await sendStatus(resume
      ? 'Auto session: resuming after a platform restart...'
      : 'Auto session: thinking about the issue...');

    const headlessAddendum = buildHeadlessAddendum(issueNumber);
    const mayorPrompt = getMayorSystemPrompt(session.app_name, false, '', !!session.app_self_hosted, null) + headlessAddendum;
    const tools = [DISPATCH_TOOL, DISPATCH_SCOUT_TOOL, SUGGEST_ANSWERS_TOOL, LIST_GITHUB_ISSUES_TOOL, GET_GITHUB_ISSUE_TOOL, WEB_FETCH_TOOL];

    // --- Phase 1: Mayor turn (same data-tool loop as the chat handler) ---
    // web_fetch is available here too (#30): if the issue links to a web
    // page, the auto-solve run can read it before dispatching.
    let mayor1;
    let mayorConvo = [{ role: 'user', content: seed }];
    let dataIters = 0;
    for (;;) {
      mayor1 = await llm.streamChat({
        messages: mayorConvo,
        systemPrompt: mayorPrompt,
        model: selectedModel,
        tools,
        apiKey: userApiKey,
      });

      const dataCalls = mayor1.toolUses.filter((t) => DATA_TOOL_NAMES.has(t.name));
      // suggest_answers (#32) is terminal here too — same dangling-
      // tool_use rationale as the interactive loop.
      const hasTerminalTool = mayor1.toolUses.some((t) =>
        t.name === 'dispatch_claude_code' || t.name === 'dispatch_scout'
        || t.name === 'suggest_answers');
      if (!dataCalls.length || hasTerminalTool || dataIters >= MAYOR_DATA_TOOLS_MAX_ITERS) break;
      dataIters += 1;

      await debitMayorUsage(mayor1.usage);
      const dataResults = await Promise.all(
        dataCalls.map((tc) => resolveDataToolResult(tc, repoOwner, repoName))
      );
      mayorConvo = [
        ...mayorConvo,
        { role: 'assistant', content: mayor1.rawContent },
        {
          role: 'user',
          content: dataCalls.map((tc, i) => ({
            type: 'tool_result',
            tool_use_id: tc.id,
            content: dataResults[i],
          })),
        },
      ];
    }

    const mayorText1 = stripFakeCompletionMarker(mayor1.text, { sessionId: session.id });
    // Q/A mode (#32): same suggestion handling as the interactive route —
    // persisted on the assistant row so the cloned session a human picks
    // up renders the answer chips. Dropped if a dispatch co-occurred.
    const { suggestions: headlessSuggestions } = resolveSuggestedAnswers(mayor1.toolUses);
    const costCents1 = mayor1.usage ? llm.estimateCostCents(mayor1.usage, selectedModel) : 0;
    if (mayorText1.trim()) {
      send('mayor_reasoning', { text: mayorText1 });
      await pool.query(
        `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents, metadata)
         VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
        [session.id, mayorText1, selectedModel, mayor1.usage.input_tokens + mayor1.usage.output_tokens, costCents1,
         JSON.stringify(headlessSuggestions ? { suggestions: headlessSuggestions } : {})]
      );
    }
    await debitMayorUsage(mayor1.usage);

    const scoutCall = mayor1.toolUses.find((t) => t.name === 'dispatch_scout');
    const dispatchCall = mayor1.toolUses.find((t) => t.name === 'dispatch_claude_code');
    const activeToolCall = scoutCall || dispatchCall || null;
    const toolKind = scoutCall ? 'scout' : (dispatchCall ? 'build' : null);

    if (!activeToolCall) {
      // Pure text turn — the Mayor asked a question (or answered directly).
      // That IS the outcome; a human picks it up from a cloned session.
      outcome = 'question';
      if (shouldPostHeadlessQuestionComment({ outcome, dispatchedTool: activeToolCall, mayorText: mayorText1 })) {
        questionTextToPost = mayorText1;
      }
    } else {
      const toolPromptArg = typeof activeToolCall.input?.prompt === 'string' && activeToolCall.input.prompt.trim()
        ? activeToolCall.input.prompt.trim()
        : seed;

      const toolArgs = {
        pool, config, req: fakeReq, res: fakeRes, session, selectedModel,
        userMessage: seed,
        toolPromptArg,
        repoOwner, repoName,
        send, sendStatus,
        stopHandle: null,
        userApiKey,
      };
      // Checkpoint BEFORE the dispatch: if the platform restarts while
      // the (detached) CC turn runs, resumeHeadlessRuns finds
      // headless_step='cc_running' + active_turn and picks the turn back
      // up from its journal instead of failing the run.
      await setHeadlessStep(pool, session.id, 'cc_running');
      const toolResult = toolKind === 'scout'
        ? await runScoutTool({ ...toolArgs, headless: true })
        : await runClaudeCodeTool({ ...toolArgs, headless: true });

      if (toolResult.isError) {
        outcome = 'question';
      } else {
        outcome = toolKind === 'scout' ? 'spec' : 'code';
      }
      // Checkpoint the outcome with the wrapping transition so a restart
      // during the phase-2 Mayor call can finalize with the right state.
      // (#170: a restart mid-decision-turn deliberately lands here too —
      // the 'wrapping' resume re-issues a tool-less wrap-up and finalizes
      // as 'spec', degrading to "stop for human review". #178: that same
      // degrade covers the questions-after-scout case, except that the
      // resume finalization flips to 'question' when the spec carries a
      // blocking Questions section — without posting a comment, since the
      // decision text died with the old process.)
      await setHeadlessStep(pool, session.id, 'wrapping', outcome);

      // Tool results fed back to the Mayor for phase 2.
      const phase2ToolResults = [];
      for (const tu of mayor1.toolUses) {
        if (tu.id === activeToolCall.id) {
          phase2ToolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: toolResult.toolResultText,
            ...(toolResult.isError ? { is_error: true } : {}),
          });
        } else if (DATA_TOOL_NAMES.has(tu.name)) {
          phase2ToolResults.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: await resolveDataToolResult(tu, repoOwner, repoName),
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
      const currentSpec = await loadSessionSpec(pool, session.id);
      const wrapPrompt = getMayorSystemPrompt(session.app_name, false, currentSpec, !!session.app_self_hosted, null) + headlessAddendum;
      const phase2Messages = [
        ...mayorConvo,
        { role: 'assistant', content: mayor1.rawContent },
        { role: 'user', content: phase2ToolResults },
      ];

      if (toolKind === 'scout' && !toolResult.isError) {
        // --- Phase 2 = DECISION turn (#170): the spec is in the system
        // prompt (wrapPrompt embeds currentSpec); the Mayor may dispatch
        // ONE headless build if the spec is straightforward, else reply in
        // plain text (identical to the old behaviour). Only DISPATCH_TOOL
        // is exposed — there is structurally no path to a second scout.
        // #178: a spec that still carries a blocking Questions section
        // after the scout's investigation routes to the reporter instead —
        // the decision text becomes a posted issue comment and the run
        // finalizes as 'question' so Generate proposal can be re-run with answers.
        const specHasQuestions = specHasBlockingQuestions(currentSpec);
        const mayor2 = await llm.streamChat({
          messages: phase2Messages,
          systemPrompt: wrapPrompt + buildHeadlessDecisionAddendum(issueNumber),
          model: selectedModel,
          tools: [DISPATCH_TOOL],
          apiKey: userApiKey,
        });
        const buildCall = mayor2.toolUses.find((t) => t.name === 'dispatch_claude_code');
        const strayCalls = mayor2.toolUses.filter((t) => t.name !== 'dispatch_claude_code');
        const mayorText2 = stripFakeCompletionMarker(mayor2.text, { sessionId: session.id });
        const costCents2 = llm.estimateCostCents(mayor2.usage, selectedModel);

        if (!mayor2.toolUses.length) {
          // Text only. Without open Questions the decision text IS the
          // wrap-up message and outcome stays 'spec'. With a Questions
          // section (#178) the text is the reporter-facing questions:
          // finalize as 'question' (re-run stays unblocked) and post it.
          // Blank text posts nothing — the spec itself carries the
          // questions for the human reviewer.
          if (specHasQuestions) {
            outcome = 'question';
            questionTextToPost = mayorText2.trim();
          }
          const finalText = mayorText2.trim()
            ? mayorText2
            : (specHasQuestions
              ? '_The spec has open questions — review the Questions section in the spec viewer after starting a session from this auto session._'
              : '_Spec drafted — review it in the spec viewer after starting a session from this auto session._');
          send('mayor_reasoning', { text: finalText });
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents)
             VALUES ($1, 'assistant', $2, $3, $4, $5)`,
            [session.id, finalText, selectedModel, mayor2.usage.input_tokens + mayor2.usage.output_tokens, costCents2]
          );
          await debitMayorUsage(mayor2.usage);
        } else {
          // The Mayor called a tool — persist its stated rationale first
          // (same text-plus-dispatch pattern phase-1 uses).
          if (mayorText2.trim()) {
            send('mayor_reasoning', { text: mayorText2 });
            await pool.query(
              `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents)
               VALUES ($1, 'assistant', $2, $3, $4, $5)`,
              [session.id, mayorText2, selectedModel, mayor2.usage.input_tokens + mayor2.usage.output_tokens, costCents2]
            );
          }
          await debitMayorUsage(mayor2.usage);

          const decisionToolResults = [];
          if (buildCall && specHasQuestions) {
            // #178 hard rail: the decision addendum forbids dispatching
            // over an open Questions section, but enforcement lives here —
            // the build never runs (no budget check, no dispatch) and the
            // phase-3 wrap-up writes the reporter-facing questions instead.
            outcome = 'question';
            await setHeadlessStep(pool, session.id, 'wrapping', outcome);
            decisionToolResults.push({
              type: 'tool_result',
              tool_use_id: buildCall.id,
              content: 'Rejected — the spec has an open Questions section; reply with ONLY the numbered questions for the issue reporter instead.',
              is_error: true,
            });
          } else if (buildCall) {
            // Re-resolve the billing path before the second dispatch: the
            // scout already spent real money this run and may have drained
            // the daily allowance. Limit-first (#212): headroom left → the
            // build stays platform-billed; allowance gone + BYOK key on
            // file → the build proceeds on the key (previously it was
            // skipped); allowance gone + no key → skip, as today.
            const buildBilling = await limits.resolveBillingPath(pool, config.jwtSecret, user.id);
            let buildResult;
            if (buildBilling.error) {
              await sendStatus('Spec drafted; implementation skipped — daily budget reached.');
              buildResult = {
                toolResultText: 'Implementation skipped — the daily LLM budget is exhausted. The spec remains the deliverable; a human will review and build it later.',
                isError: true,
              };
            } else {
              // Later phase calls (the build itself, the phase-3 wrap-up
              // and its debits) must bill the re-resolved payer — the
              // turn-start resolution may differ now that the scout spent.
              userApiKey = buildBilling.apiKey;
              await sendStatus('Auto session: spec looks straightforward — implementing it now...');
              const buildPromptArg = typeof buildCall.input?.prompt === 'string' && buildCall.input.prompt.trim()
                ? buildCall.input.prompt.trim()
                : seed;
              // Same pre-dispatch checkpoint as phase-1: the step machine
              // reuses 'cc_running'; active_turn.mode === 'build'
              // disambiguates scout vs build on resume.
              await setHeadlessStep(pool, session.id, 'cc_running');
              buildResult = await runClaudeCodeTool({
                ...toolArgs, userApiKey, toolPromptArg: buildPromptArg, headless: true,
              });
            }
            // Build error degrades to 'spec' (NOT 'question' like the
            // phase-1 build path): the spec is the durable artifact and a
            // failed implementation attempt must not mask it.
            outcome = buildResult.isError ? 'spec' : 'spec_code';
            await setHeadlessStep(pool, session.id, 'wrapping', outcome);
            decisionToolResults.push({
              type: 'tool_result',
              tool_use_id: buildCall.id,
              content: buildResult.toolResultText,
              ...(buildResult.isError ? { is_error: true } : {}),
            });
          }
          // Any other tool call is rejected without running — the
          // structural enforcement of "max one scout per run".
          for (const tu of strayCalls) {
            decisionToolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: 'Only dispatch_claude_code is available in the decision turn.',
              is_error: true,
            });
          }

          // --- Phase 3: tool-less wrap-up (mirrors the old phase-2). ---
          const mayor3 = await llm.streamChat({
            messages: [
              ...phase2Messages,
              { role: 'assistant', content: mayor2.rawContent },
              { role: 'user', content: decisionToolResults },
            ],
            systemPrompt: wrapPrompt,
            model: selectedModel,
            // #32: on the rejected-build (question) path the wrap-up
            // re-asks the human-only questions — expose suggest_answers so
            // it can attach answer chips, mirroring the phase-1 question
            // turn. Other wrap-up outcomes ignore the tool.
            tools: [SUGGEST_ANSWERS_TOOL],
            apiKey: userApiKey,
          });
          let mayorText3 = stripFakeCompletionMarker(mayor3.text, { sessionId: session.id });
          // #32: persist suggestions only on the question outcome — that's
          // the row a cloned session forwards onto its follow-up to render
          // the answer chips. Non-question wrap-ups carry no metadata.
          const { suggestions: decisionSuggestions } = outcome === 'question'
            ? resolveSuggestedAnswers(mayor3.toolUses)
            : { suggestions: null };
          // #178: on the rejected-build path the wrap-up text IS the
          // reporter-facing questions; blank text posts nothing (the spec
          // carries the questions for the human reviewer).
          if (outcome === 'question') questionTextToPost = mayorText3.trim();
          if (!mayorText3.trim()) {
            mayorText3 = outcome === 'spec_code'
              ? '_Spec drafted and change committed — start a session from this auto session to review it and propose it to the group._'
              : outcome === 'question'
                ? '_The spec has open questions — review the Questions section in the spec viewer after starting a session from this auto session._'
                : '_Spec drafted — the implementation attempt did not complete; review the spec in the spec viewer after starting a session from this auto session._';
          }
          send('mayor_reasoning', { text: mayorText3 });
          const costCents3 = llm.estimateCostCents(mayor3.usage, selectedModel);
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents, metadata)
             VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
            [session.id, mayorText3, selectedModel, mayor3.usage.input_tokens + mayor3.usage.output_tokens, costCents3,
             JSON.stringify(decisionSuggestions ? { suggestions: decisionSuggestions } : {})]
          );
          await debitMayorUsage(mayor3.usage);
        }
      } else {
        // --- Phase 2: Mayor wrap-up (mirrors the chat handler) — scout
        // error, direct phase-1 build, or any other dispatch path. ---
        const mayor2 = await llm.streamChat({
          messages: phase2Messages,
          systemPrompt: wrapPrompt,
          model: selectedModel,
          tools,
          toolChoice: { type: 'none' },
          apiKey: userApiKey,
        });

        let mayorText2 = stripFakeCompletionMarker(mayor2.text, { sessionId: session.id });
        if (!mayorText2.trim()) {
          mayorText2 = toolResult.isError
            ? "_The auto session's dispatch didn't finish successfully — see the status above._"
            : '_Change committed and pushed — start a session from this auto session to review it and propose it to the group._';
        }
        send('mayor_reasoning', { text: mayorText2 });
        const costCents2 = llm.estimateCostCents(mayor2.usage, selectedModel);
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents)
           VALUES ($1, 'assistant', $2, $3, $4, $5)`,
          [session.id, mayorText2, selectedModel, mayor2.usage.input_tokens + mayor2.usage.output_tokens, costCents2]
        );
        await debitMayorUsage(mayor2.usage);
      }
    }

    await pool.query(
      `UPDATE chat_sessions SET headless_status = 'ready', headless_outcome = $1, headless_step = NULL, last_activity_at = NOW()
       WHERE id = $2`,
      [outcome, session.id]
    );
    send('headless_update', { status: 'ready', outcome, issueNumber, appSlug: session.app_slug });
    // #150/#178: post the reporter-facing questions on the GitHub issue so
    // the reporter sees them without entering the platform — written by a
    // pure-text phase-1 turn, or by the decision turn when the scout's spec
    // still carried a blocking Questions section. Deliberately AFTER the
    // terminal status write: the boot resume only re-drives 'generating'
    // rows, so double-posting on restart is impossible; a crash between the
    // UPDATE and the post degrades to no comment (today's behavior).
    if (questionTextToPost) {
      const posted = await postHeadlessQuestionComment({
        repoOwner, repoName, issueNumber, questionText: questionTextToPost,
      });
      if (posted) await sendStatus(`Posted clarifying questions to issue #${issueNumber}`);
    }
    // #161: always notify the user who started the run (no arming —
    // kicking off an auto-solve opts you into its completion ping).
    await notifyAutoSolveDone(pool, {
      userId: user.id, appId: session.app_id, sessionId: session.id, detail: outcome,
    });
    log.info('sessions', 'Headless session ready', { sessionId: session.id, issueNumber, outcome });
  } catch (err) {
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
    log.error('sessions', 'Headless session failed', { sessionId: session.id, err: err.message, stack: err.stack });
    await pool.query(
      `UPDATE chat_sessions SET headless_status = 'failed', headless_step = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    await sendStatus(`Auto session failed: ${String(err.message || err).substring(0, 200)}`);
    send('headless_update', { status: 'failed', issueNumber, appSlug: session.app_slug });
    // #161: a failed run is still a completion — the user must come back
    // and retry (or read the failure), so notify with detail='failed'.
    await notifyAutoSolveDone(pool, {
      userId: user.id, appId: session.app_id, sessionId: session.id, detail: 'failed',
    });
  } finally {
    // unref: a fire-and-forget cleanup timer must not hold the process
    // open (it also kept the node:test runner alive for the full delay).
    setTimeout(() => sessionBus.clearSession(session.id), 30000).unref();
  }
}

// Boot hook: resume headless auto sessions that were 'generating' when
// the platform went down, instead of blanket-failing them (the old
// failOrphanedHeadlessRuns behavior — now narrowed in migrate.js to
// only rows that predate the step machine). Driven by the persisted
// headless_step checkpoint:
//   planning   → re-issue the whole Mayor turn from the persisted seed
//                message (cheap, retry-safe — nothing was dispatched yet).
//   cc_running → pick the detached CC turn back up from its journal
//                (chat_sessions.active_turn), run headless post-
//                processing, then continue with the wrap-up.
//   wrapping   → the dispatch finished and its outcome was checkpointed;
//                re-issue just the phase-2 Mayor call from the persisted
//                transcript.
// Anything that can't be carried forward is marked 'failed' — same
// terminal state as before, just no longer the only possibility.
async function resumeHeadlessRuns(config) {
  const pool = getPool(config);
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
              a.self_hosted AS app_self_hosted, u.username
       FROM chat_sessions cs
       JOIN apps a ON cs.app_id = a.id
       JOIN users u ON cs.user_id = u.id
       WHERE cs.is_headless = TRUE AND cs.headless_status = 'generating'`
    ));
  } catch (err) {
    log.error('sessions', 'resumeHeadlessRuns query failed', { err: err.message });
    return;
  }
  if (!rows.length) return;
  log.info('sessions', 'Resuming headless runs after restart', {
    count: rows.length, sessionIds: rows.map((r) => r.id),
  });
  for (const session of rows) {
    resumeOneHeadlessRun({ pool, config, session }).catch(async (err) => {
      log.error('sessions', 'Headless resume failed — marking run failed', {
        sessionId: session.id, err: err.message, stack: err.stack,
      });
      await failHeadlessRun(pool, session, `Auto session could not be resumed after restart: ${String(err.message || err).substring(0, 200)}`);
    });
  }
}

// Terminal failure for a resumed headless run: same row updates + WS
// broadcast the live runner's catch block performs.
async function failHeadlessRun(pool, session, message) {
  const { broadcastGlobal } = require('../services/ws');
  await pool.query(
    `UPDATE chat_sessions SET headless_status = 'failed', headless_step = NULL WHERE id = $1`,
    [session.id]
  ).catch(() => {});
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, metadata)
     VALUES ($1, 'system', $2, $3)`,
    [session.id, message, JSON.stringify({})]
  ).catch(() => {});
  broadcastGlobal({
    type: 'session_event', sessionId: session.id, event: 'headless_update',
    status: 'failed', issueNumber: session.headless_issue_number, appSlug: session.app_slug,
  });
  // #161: terminal state — same completion notification the live
  // runner's catch block fires.
  await notifyAutoSolveDone(pool, {
    userId: session.user_id, appId: session.app_id, sessionId: session.id, detail: 'failed',
  });
}

async function resumeOneHeadlessRun({ pool, config, session }) {
  const { broadcastGlobal } = require('../services/ws');
  const issueNumber = session.headless_issue_number;
  const user = { id: session.user_id, username: session.username };
  const [, repoOwner, repoName] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!repoOwner || !repoName) {
    return failHeadlessRun(pool, session, 'Auto session failed after restart: no GitHub repo configured.');
  }

  // Limit-first (#212): the resumed run's NEW calls (re-driven phases,
  // wrap-up Mayor turn) bill the allowance while it has headroom, then
  // the owner's BYOK key. On { error } (allowance gone, no key) resume
  // proceeds platform-billed like it always has — the Anthropic proxy
  // enforces the cap per-call, so the run fails with the same message
  // it would have shown live rather than dying silently here.
  const resumeBilling = await limits.resolveBillingPath(pool, config.jwtSecret, session.user_id);
  const userApiKey = resumeBilling.error ? null : resumeBilling.apiKey;
  // The model picked at start isn't a session column, but every persisted
  // assistant turn carries it — reuse the latest, else the default.
  const { rows: modelRows } = await pool.query(
    `SELECT model FROM chat_session_messages
     WHERE session_id = $1 AND role = 'assistant' AND model IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [session.id]
  );
  const selectedModel = models.resolve(modelRows[0]?.model);

  const step = session.headless_step || 'planning';
  log.info('sessions', 'Resuming headless run', { sessionId: session.id, issueNumber, step });

  if (step === 'planning') {
    // Nothing was dispatched yet — re-issue the whole Mayor turn. The
    // seed user message already exists (resume: true skips re-inserting);
    // re-fetch the issue (+ its comments, #150) for the in-memory seed
    // string the dispatch helpers receive.
    const { issue } = await github.fetchPublicIssue(repoOwner, repoName, issueNumber);
    const { comments } = await github.fetchIssueComments(repoOwner, repoName, issueNumber);
    let botUsername = null;
    try { botUsername = await github.getBotUsername(); } catch {}
    return runHeadlessSession({
      pool, config, session, user, selectedModel,
      repoOwner, repoName, userApiKey, issueNumber, issue,
      comments, botUsername,
      resume: true,
    });
  }

  let outcome = session.headless_outcome || 'question';
  let dispatchSummary = null;

  if (step === 'cc_running') {
    const activeTurn = session.active_turn || null;
    if (!activeTurn || !activeTurn.journal) {
      return failHeadlessRun(pool, session, 'Auto session failed after restart: its coding turn left no resumable record.');
    }
    // Replay/follow the detached turn's journal. Progress lines are
    // rebuilt WHOLESALE onto the latest progress row (replay re-feeds
    // every line from the start of the turn).
    const progressLines = [];
    let flushQueued = false;
    const flushProgress = () => {
      flushQueued = false;
      pool.query(
        `UPDATE chat_session_messages
         SET metadata = jsonb_set(metadata, '{progressLog}', $1::jsonb)
         WHERE id = (
           SELECT id FROM chat_session_messages
           WHERE session_id = $2 AND role = 'system'
             AND metadata->>'progressLog' IS NOT NULL
           ORDER BY id DESC LIMIT 1
         )`,
        [JSON.stringify(progressLines), session.id]
      ).catch(() => {});
    };
    const result = await worker.resumeTurnFromJournal(session.id, {
      journal: activeTurn.journal,
      onProgress: (text) => {
        broadcastGlobal({ type: 'session_event', sessionId: session.id, event: 'cc_progress', text });
        progressLines.push(text);
        if (!flushQueued) {
          flushQueued = true;
          setTimeout(flushProgress, 1000);
        }
      },
    });
    flushProgress();
    await worker.clearActiveTurn(session.id);

    // #174: the journal replay rebuilt the turn's self-reported cost —
    // debit it before the recovery check below, because the Anthropic
    // invoice is paid whether or not the turn produced anything (same
    // rationale as the turn-end debit in runClaudeCodeTool). active_turn
    // rows persisted before the byok flag shipped fall back to
    // key-on-file at resume time.
    if (result.costUsd) {
      const byok = activeTurn.byok ?? !!userApiKey;
      await limits.recordSpend(pool, user.id, Math.round(result.costUsd * 100), { byok });
    }

    const producedAnything = result.execExitSeen || result.resultSeen
      || !!(result.lastResultText || '').trim();
    if (!producedAnything) {
      return failHeadlessRun(pool, session, 'Auto session failed after restart: its coding turn could not be recovered.');
    }

    // Persist the CC session id for later cloned sessions' --resume.
    const newCcId = result.sessionId || result.initSessionId || null;
    if (newCcId && newCcId !== session.cc_session_id) {
      await pool.query(
        'UPDATE chat_sessions SET cc_session_id = $1 WHERE id = $2',
        [newCcId, session.id]
      ).catch(() => {});
    }

    // Headless post-processing — mirrors runScoutTool / runClaudeCodeTool's
    // headless success paths (spec persist / testing notes), never PR or
    // staging (the headless contract).
    if (activeTurn.mode === 'scout') {
      const ccText = stripSpecWrapperFence((result.lastResultText || '').trim());
      if (ccText && !result.fatalError) {
        await pool.query(
          'UPDATE chat_sessions SET spec_md = $1 WHERE id = $2',
          [ccText, session.id]
        );
        const specVersion = await snapshotSessionSpec(pool, session.id, ccText);
        const lineCount = ccText.split('\n').length;
        await pool.query(
          `INSERT INTO chat_session_messages (session_id, role, content, metadata)
           VALUES ($1, 'system', $2, $3)`,
          [session.id, `Scout drafted a ${lineCount}-line spec from the codebase.`,
            // specPreview drives the tappable spec card in dev-chat; omitting
            // it here left recovered scout turns (and their clones) with a
            // message claiming a spec exists but no card to open it.
            JSON.stringify({ specPreview: buildSpecPreview(ccText), specLines: lineCount, scoutOutput: ccText, specVersion })]
        ).catch(() => {});
        // #178: blocking Questions in the recovered spec finalize as
        // 'question' so the answer-and-re-run loop survives the restart
        // (no comment is posted — there is no decision turn on resume).
        outcome = specHasBlockingQuestions(ccText) ? 'question' : 'spec';
        dispatchSummary = `The scout investigated the repo and drafted a ${lineCount}-line markdown spec. It now lives in the session's spec doc.`;
      } else {
        outcome = 'question';
        dispatchSummary = 'The scout did not complete successfully — no spec was produced.';
      }
    } else {
      const testing = testingNotes.extract(result.lastResultText || '');
      const hasChanges = result.ahead > 0 && !!result.sha;
      // #170: a headless session only ever has spec_md if its own scout
      // wrote it this run — so spec_md present means this build was the
      // decision turn's dispatch: success is 'spec_code', and failure
      // degrades to 'spec' (the spec is the durable artifact), not
      // 'question' like the phase-1 direct-build path.
      if (hasChanges && !result.fatalError) {
        if (testing.testingMd || testing.testingPath) {
          await pool.query(
            'UPDATE chat_sessions SET testing_md = $1, testing_path = $2, testing_paths = $3 WHERE id = $4',
            [testing.testingMd, testing.testingPath, JSON.stringify(testing.testingPaths || []), session.id]
          ).catch(() => {});
        }
        outcome = session.spec_md ? 'spec_code' : 'code';
        dispatchSummary = `Commit ${result.sha.substring(0, 8)} pushed to ${session.branch_name}. `
          + 'Headless mode: no PR was opened and no staging preview was built.'
          + (session.spec_md ? ' The change implements the spec drafted earlier this run (in the session spec doc).' : '')
          + (testing.cleanedText ? `\n\nWhat the agent did:\n${testing.cleanedText.slice(0, 2000)}` : '');
      } else {
        outcome = session.spec_md ? 'spec' : 'question';
        dispatchSummary = (result.fatalError
          ? `The coding agent hit an error: ${result.fatalError.substring(0, 200)}`
          : 'The coding agent finished without pushing any changes.')
          + (session.spec_md ? ' The spec drafted earlier this run is still the reviewable artifact.' : '');
      }
    }
    await setHeadlessStep(pool, session.id, 'wrapping', outcome);
  }

  // #178: a 'wrapping' checkpoint written before/during the decision turn
  // carries outcome 'spec' even when the spec still has a blocking
  // Questions section — flip it so re-running Generate proposal stays unblocked
  // (no comment is posted; the decision text died with the old process).
  if (outcome === 'spec' && specHasBlockingQuestions(session.spec_md)) {
    outcome = 'question';
  }

  // step === 'wrapping' (directly, or fallen through from cc_running):
  // re-issue just the phase-2 Mayor wrap-up from the persisted
  // transcript. The original tool_use blocks died with the old process,
  // so the dispatch outcome is delivered as a plain user message — the
  // Anthropic API merges/accepts consecutive same-role messages.
  const { rows: msgRows } = await pool.query(
    `SELECT role, content FROM chat_session_messages
     WHERE session_id = $1 AND role IN ('user', 'assistant')
     ORDER BY id ASC`,
    [session.id]
  );
  const convo = msgRows
    .filter((r) => (r.content || '').trim())
    .map((r) => ({ role: r.role, content: r.content }));
  convo.push({
    role: 'user',
    content: `[SYSTEM NOTE — not the human] The platform restarted while this auto session was running; it has been resumed. The dispatched work finished with outcome '${outcome}'.${dispatchSummary ? `\n\nDispatch result:\n${dispatchSummary}` : ''}\n\nWrite the final wrap-up message for the human reviewer who will pick this session up later: state what was done and what they should do next. Do not call any tools.`,
  });

  const headlessAddendum = buildHeadlessAddendum(issueNumber);
  const currentSpec = await loadSessionSpec(pool, session.id);
  const wrapPrompt = getMayorSystemPrompt(session.app_name, false, currentSpec, !!session.app_self_hosted, null) + headlessAddendum;
  // No tools passed → plain text turn; the API can't call anything, so
  // tool_choice is unnecessary (and invalid without a tools array).
  const mayor2 = await llm.streamChat({
    messages: convo,
    systemPrompt: wrapPrompt,
    model: selectedModel,
    apiKey: userApiKey,
  });

  let mayorText2 = (mayor2.text || '').trim();
  if (!mayorText2) {
    mayorText2 = outcome === 'spec'
      ? '_Spec drafted — review it in the spec viewer after starting a session from this auto session._'
      : outcome === 'spec_code'
        ? '_Spec drafted and change committed — start a session from this auto session to open the PR._'
        : outcome === 'code'
          ? '_Change committed and pushed — start a session from this auto session to open the PR._'
          : "_The auto session's dispatch didn't finish successfully — see the status above._";
  }
  const costCents2 = mayor2.usage ? llm.estimateCostCents(mayor2.usage, selectedModel) : 0;
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents)
     VALUES ($1, 'assistant', $2, $3, $4, $5)`,
    [session.id, mayorText2, selectedModel,
      mayor2.usage ? mayor2.usage.input_tokens + mayor2.usage.output_tokens : 0, costCents2]
  );
  await limits.recordSpend(pool, user.id, costCents2, { byok: !!userApiKey });

  await pool.query(
    `UPDATE chat_sessions SET headless_status = 'ready', headless_outcome = $1, headless_step = NULL, last_activity_at = NOW()
     WHERE id = $2`,
    [outcome, session.id]
  );
  broadcastGlobal({
    type: 'session_event', sessionId: session.id, event: 'headless_update',
    status: 'ready', outcome, issueNumber, appSlug: session.app_slug,
  });
  // #161: a restart-resumed run completing is the same user-facing
  // moment as a live one — notify the user who started it.
  await notifyAutoSolveDone(pool, {
    userId: user.id, appId: session.app_id, sessionId: session.id, detail: outcome,
  });
  log.info('sessions', 'Headless session resumed to ready', { sessionId: session.id, issueNumber, outcome });
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
    'Dispatch the coding agent in read-only PLAN MODE to investigate the repo and draft or revise a grounded markdown spec. '
    + 'Use for ALL spec work in a session — the initial draft AND every later revision, large or small. '
    + "The agent reads files and writes prose; it CANNOT edit, commit, or push. Output replaces the session's spec doc "
    + '(when a spec already exists, the scout sees it and outputs a revised full document, preserving accepted content). '
    + 'Slow (~30-60s). At most one call per user message.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Instructions for the scout. For an initial draft, describe what to investigate (e.g. "Read the relevant files '
          + 'for the leaderboard and draft a spec for adding realtime updates"). The document structure is fixed by the '
          + 'platform — a user-facing half and a technical half, rendered as tabs — so do not specify a shape; describe '
          + 'what to investigate or change, not how to organize it. For a revision, describe precisely what to change in '
          + 'the existing spec (the current spec doc is auto-injected into the scout\'s prompt — do not restate it). 1-3 sentences.',
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
    + 'pull requests are excluded and long bodies are clipped with an explicit '
    + '"[truncated — use get_github_issue(N) for full text]" marker; call get_github_issue for the full body. '
    + 'Call this when the user mentions the issue tracker, asks what issues or bugs are filed, '
    + 'or when planning work that may already be reported, so your reply is grounded in real issues. '
    + 'It only READS issues — it cannot create, comment on, edit, or close them. Takes no input.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

// Companion data tool to list_github_issues (#158): fetch ONE issue with
// its FULL (untruncated) body. Same read-only, available-every-turn
// posture; resolves in-process via github.fetchPublicIssue (cache-first,
// also resolves closed issues). Scout + build reach the identical
// capability via `usernode-issues <number>`.
const GET_GITHUB_ISSUE_TOOL = {
  name: 'get_github_issue',
  description:
    "Fetch ONE GitHub issue from this app's repository with its FULL, untruncated body (read-only). "
    + 'Returns JSON `{ issue: { number, title, body, labels, updatedAt, htmlUrl } }`, or '
    + '`{ issue: null, note }` when it cannot be resolved. '
    + 'Use it when a body from list_github_issues ends with a "[truncated …]" marker and you need the rest, '
    + 'or when the user asks about a specific issue number. Also resolves recently-closed issues. '
    + 'It only READS the issue — it cannot create, comment on, edit, or close it.',
  input_schema: {
    type: 'object',
    properties: {
      number: {
        type: 'integer',
        description: 'The issue number to fetch (e.g. 158 for issue #158).',
      },
    },
    required: ['number'],
  },
};

// Third data tool (#30): fetch ONE public web page and return its text,
// so the Mayor can read a URL the user linked (docs, an example site, an
// API reference) inline in the turn instead of guessing or burning a
// 30-60s scout container on one page. Same read-only, available-every-
// turn posture as the issue tools; resolves in-process via
// services/web-fetch.js, which never throws and enforces SSRF blocking,
// redirect re-validation, a 10s budget, and size/content caps.
const WEB_FETCH_TOOL = {
  name: 'web_fetch',
  description:
    'Fetch ONE public web page and return its extracted text as JSON (read-only). '
    + 'Returns `{ url, finalUrl, status, contentType, title, content, truncated }` on success, or '
    + '`{ url, content: null, note }` when the page cannot be fetched (private/internal address, timeout, '
    + 'redirect limit, non-text content, network error). '
    + 'Call it when the user shares a URL, or when answering depends on the content of an external page — '
    + 'read the page BEFORE writing scout/build prompts grounded in it, so dispatches reflect the real content. '
    + 'It fetches public pages only: it cannot log in, click, run scripts, or reach private/internal network '
    + 'addresses. HTML is returned as plain text (scripts/styles stripped); very large pages are truncated '
    + 'with `truncated: true` and an explicit marker. Images, PDFs, and other binary content are refused with a note.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The absolute http(s) URL of the page to fetch (e.g. https://example.com/docs/api).',
      },
    },
    required: ['url'],
  },
};

// Q/A mode (#32): structured suggested answers attached to the Mayor's
// clarifying questions. NOT a dispatch — the turn still ends as a plain
// question turn. The input is sanitized server-side
// (sanitizeSuggestedAnswers) and persisted as metadata.suggestions on
// the assistant row so the dev-chat client renders tappable answer
// chips both live (the 'suggestions' SSE event) and on refresh.
const SUGGEST_ANSWERS_TOOL = {
  name: 'suggest_answers',
  description:
    'Attach short suggested answers to the clarifying questions you are asking in THIS SAME message, so the user can tap one instead of typing. '
    + 'Call this ONLY when your message asks clarifying questions per the CLARITY GATE — never on a normal reply, and NEVER alongside '
    + 'dispatch_scout or dispatch_claude_code (asking and dispatching in the same turn is forbidden; if both appear, the suggestions are dropped). '
    + 'Provide one entry per question, in the same order as the numbered questions in your text, with your suggested default FIRST. '
    + 'Every answer must be a short (under 80 characters), self-contained reply the user could send verbatim.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description:
          'One entry per clarifying question asked in this message (1-3 entries, matching your numbered questions in order).',
        items: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'Short restatement of the question (a few words — used as the chip-row label).',
            },
            answers: {
              type: 'array',
              items: { type: 'string' },
              description:
                '2-5 short candidate answers, your suggested default FIRST. Each must read as a complete reply the user could send verbatim.',
            },
          },
          required: ['question', 'answers'],
        },
      },
    },
    required: ['questions'],
  },
};

// Sanitizer for suggest_answers tool input (#32). Caps mirror the
// clarity gate (at most 3 questions) plus the tool contract (5 answers
// each, short strings). Returns a clean [{ question, answers }] array,
// or null when nothing usable survives — callers skip persistence and
// the SSE event on null, so a malformed call degrades to today's
// plain-text questions instead of breaking the turn.
const QA_MAX_QUESTIONS = 3;
const QA_MAX_ANSWERS = 5;
const QA_MAX_ANSWER_LEN = 80;
const QA_MAX_QUESTION_LEN = 200;

function sanitizeSuggestedAnswers(input) {
  const raw = input && Array.isArray(input.questions) ? input.questions : null;
  if (!raw) return null;
  const toText = (v, max) => (
    (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      ? String(v).trim().slice(0, max).trim()
      : ''
  );
  const out = [];
  for (const entry of raw) {
    if (out.length >= QA_MAX_QUESTIONS) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const question = toText(entry.question, QA_MAX_QUESTION_LEN);
    const answers = (Array.isArray(entry.answers) ? entry.answers : [])
      .map((a) => toText(a, QA_MAX_ANSWER_LEN))
      .filter(Boolean)
      .slice(0, QA_MAX_ANSWERS);
    if (!answers.length) continue;
    out.push({ question, answers });
  }
  return out.length ? out : null;
}

// Resolve a phase-1 suggest_answers call against the same-turn tool set
// (#32). The clarity gate forbids asking + dispatching in one turn, so a
// dispatch/scout tool_use in the same response wins and the suggestions
// are dropped — same server-side priority-enforcement posture as the
// scout > build resolution in the chat handler.
function resolveSuggestedAnswers(toolUses) {
  const calls = Array.isArray(toolUses) ? toolUses : [];
  const suggestCall = calls.find((t) => t && t.name === 'suggest_answers');
  if (!suggestCall) return { suggestions: null, droppedForDispatch: false };
  const hasDispatch = calls.some((t) =>
    t && (t.name === 'dispatch_claude_code' || t.name === 'dispatch_scout'));
  if (hasDispatch) return { suggestions: null, droppedForDispatch: true };
  return { suggestions: sanitizeSuggestedAnswers(suggestCall.input), droppedForDispatch: false };
}

// Quick-reply pills (#285): flat next-step suggestions the Mayor attaches
// to a normal reply or post-build wrap-up, rendered as tappable pills ABOVE
// the dev-chat composer. Tapping a pill PREFILLS the text box (editable,
// never auto-send) — distinct from the #32 answer chips, which send. The
// input is sanitized server-side and persisted as metadata.quickReplies on
// the assistant row so the client renders pills live (the 'quick_replies'
// SSE event) and on refresh.
const SUGGEST_REPLIES_TOOL = {
  name: 'suggest_replies',
  description:
    'Attach 2-3 short suggested NEXT messages the user is likely to want to send next, shown as tappable pills above the message box. '
    + 'Tapping a pill prefills the text box (the user can edit before sending), so each must read as a complete first-person message the user could send verbatim — e.g. "Preview the change", "Propose it to the group", "Make the button bigger". '
    + 'Call this on normal replies and post-build wrap-ups to offer the likely next step (built → preview / propose / tweak; spec drafted → build / revise; build running → check status / stop). '
    + 'Do NOT use this for formal clarifying questions — those use suggest_answers instead; never emit both in the same turn. '
    + 'This does NOT count against the one-tool-per-message limit.',
  input_schema: {
    type: 'object',
    properties: {
      replies: {
        type: 'array',
        description:
          '2-3 short candidate next messages, most likely first. Each must be a complete reply the user could send verbatim (under 80 characters).',
        items: { type: 'string' },
      },
    },
    required: ['replies'],
  },
};

// Sanitizer for suggest_replies tool input (#285). Coerce to trimmed
// strings, drop empties, dedupe case-insensitively, cap count + length.
// Returns a clean string[] or null when nothing usable survives — callers
// skip persistence and the SSE event on null, so a malformed call degrades
// to "no pills" instead of breaking the turn.
const QR_MAX_REPLIES = 3;
const QR_MAX_REPLY_LEN = 80;

function sanitizeQuickReplies(input) {
  const raw = input && Array.isArray(input.replies) ? input.replies : null;
  if (!raw) return null;
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (out.length >= QR_MAX_REPLIES) break;
    const text = (typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean')
      ? String(r).trim().slice(0, QR_MAX_REPLY_LEN).trim()
      : '';
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.length ? out : null;
}

// Resolve a suggest_replies call against the same-turn tool set (#285).
// Pills should reflect the FINAL state of the turn, so a phase-1 call is
// dropped when a dispatch/scout tool co-occurs (phase-2 regenerates them
// post-build) or when suggest_answers co-occurs (the inline answer chips
// take precedence and the above-box row stays empty).
function resolveQuickReplies(toolUses) {
  const calls = Array.isArray(toolUses) ? toolUses : [];
  const repliesCall = calls.find((t) => t && t.name === 'suggest_replies');
  if (!repliesCall) return null;
  const hasDispatch = calls.some((t) =>
    t && (t.name === 'dispatch_claude_code' || t.name === 'dispatch_scout'));
  const hasSuggestAnswers = calls.some((t) => t && t.name === 'suggest_answers');
  if (hasDispatch || hasSuggestAnswers) return null;
  return sanitizeQuickReplies(repliesCall.input);
}

// The Mayor's read-only DATA tools — resolved in-process and looped
// back as tool_results (unlike the terminal dispatch tools).
const DATA_TOOL_NAMES = new Set(['list_github_issues', 'get_github_issue', 'web_fetch']);

// Cap on how many consecutive data-tool fetches we'll service
// within a single Mayor turn before forcing the model to move on. Bounds
// the worst case where the model loops on the data tools instead of acting.
const MAYOR_DATA_TOOLS_MAX_ITERS = 3;

// Resolve a list_github_issues tool call to the JSON string we hand back as
// tool_result content. Owner/repo come straight from apps.repo_url; when
// they're absent we return the well-formed empty-with-note shape rather
// than erroring. github.fetchPublicIssues never throws.
async function resolveGithubIssuesToolResult(repoOwner, repoName) {
  if (!repoOwner || !repoName) {
    return JSON.stringify({ issues: [], truncatedList: false, note: 'no repo' });
  }
  // Clip verbose bodies for the model's context — the cache itself carries
  // full bodies for the web route / Create-PR seeding (#158). The marker
  // names get_github_issue so the Mayor knows the on-demand escape hatch.
  const result = await github.fetchPublicIssues(repoOwner, repoName);
  return JSON.stringify(github.truncateIssueBodies(result, (n) => `get_github_issue(${n})`));
}

// Resolve a get_github_issue tool call: ONE issue, FULL body (#158).
// github.fetchPublicIssue never throws and validates the number itself.
async function resolveGithubIssueToolResult(repoOwner, repoName, number) {
  if (!repoOwner || !repoName) {
    return JSON.stringify({ issue: null, note: 'no repo' });
  }
  return JSON.stringify(await github.fetchPublicIssue(repoOwner, repoName, number));
}

// Resolve a web_fetch tool call (#30). webFetch.fetchUrl never throws —
// SSRF refusals, timeouts, and network errors all come back as
// { url, content: null, note } and the Mayor reasons with the note.
async function resolveWebFetchToolResult(rawUrl) {
  return JSON.stringify(await webFetch.fetchUrl(rawUrl));
}

// Route one data tool_use to its resolver. Callers guard on
// DATA_TOOL_NAMES so `tu.name` is always one of the three.
function resolveDataToolResult(tu, repoOwner, repoName) {
  if (tu.name === 'web_fetch') {
    return resolveWebFetchToolResult(tu.input && tu.input.url);
  }
  return tu.name === 'get_github_issue'
    ? resolveGithubIssueToolResult(repoOwner, repoName, tu.input && tu.input.number)
    : resolveGithubIssuesToolResult(repoOwner, repoName);
}

// Status line for a batch of data-tool calls being resolved. web_fetch
// shows the hostname (not the full URL — the persisted system row stays
// tidy); issue calls keep the historical wording.
function dataToolStatusLine(calls) {
  const wf = calls.find((tc) => tc.name === 'web_fetch');
  if (wf) {
    try {
      return `Fetching ${new URL(String(wf.input && wf.input.url)).hostname}...`;
    } catch {
      return 'Fetching a web page...';
    }
  }
  return "Reading the repo's GitHub issues...";
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

// The synthetic label the harness folds a REAL coding-agent run under
// when replaying history into the Mayor's context (see buildMayorMessages
// below). It is reserved for the harness — the system prompt forbids the
// Mayor from ever typing it, and stripFakeCompletionMarker enforces that
// server-side. Centralized so the generator, the scrub, and the system
// prompt can't drift apart.
const CODING_AGENT_COMPLETED_MARKER = '[CODING AGENT COMPLETED]';
const COMPLETION_MARKER_RE = /\[CODING AGENT COMPLETED\][\s\S]*$/i;

// Defense in depth (#358): remove a hallucinated completion marker (and
// anything after it) from Mayor-authored text. The marker is ONLY ever
// legitimately produced by buildMayorMessages from a ccOutput system row,
// so it must never survive in a persisted assistant row — if the Mayor
// reproduces it, it is faking a coding-agent run that never happened. Pure
// + trims; returns the input unchanged when no marker is present. Pass
// sessionId to have the (rare) regression logged.
function stripFakeCompletionMarker(text, { sessionId } = {}) {
  if (typeof text !== 'string') return '';
  // Fast path: most Mayor turns never contain the marker, so bail early.
  if (!COMPLETION_MARKER_RE.test(text)) return text;
  if (sessionId) {
    log.warn('sessions', 'Mayor wrote fake [CODING AGENT COMPLETED] without a real run — stripping', {
      sessionId, preview: text.substring(0, 300),
    });
  }
  return text.replace(COMPLETION_MARKER_RE, '').trim();
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
      // Outcome-aware label (#358): only a run that actually changed code is
      // folded under the "COMPLETED" marker. No-op / error runs carry a
      // distinct label so the Mayor doesn't see (and imitate) a "completed"
      // entry for work that never landed. Rows without ccOutcome — legacy
      // history and the staging seeds — keep the legacy completed label.
      const outcome = row.metadata.ccOutcome;
      const label = outcome === 'no_changes'
        ? '[CODING AGENT RAN — NO CHANGES]'
        : outcome === 'error'
          ? '[CODING AGENT FAILED]'
          : CODING_AGENT_COMPLETED_MARKER;
      pushAssistant(`${label}:\n${summary}`);
    } else if (row.role === 'assistant') {
      pushAssistant(row.content);
    } else if (row.role === 'user') {
      messages.push({ role: 'user', content: row.content });
    }
  }
  return messages;
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
  headless = false,
}) {
  activeWorkers.add(session.id);
  // #50: wall-clock start for the durationMs persisted on terminal
  // statuses, so the dev-chat "(took Xm Ys)" suffix survives reloads.
  const turnStartedMs = Date.now();
  const modelLabel = prettyModelLabel(selectedModel);
  await sendStatus(`Scouting the repo for context (${modelLabel})...`);

  await worker.ensureWorkerImage();

  // When a spec already exists, this scout run is a REVISION: the scout
  // sees the current doc verbatim and outputs a full revised document,
  // preserving accepted content. This replaced the Mayor's old
  // in-process write_spec/edit_spec tools (#111) — Claude Code does a
  // much better job at spec drafting and revision than the Mayor did.
  const existingSpec = (await loadSessionSpec(pool, session.id)).trim();
  const revisionBlock = existingSpec
    ? `

This session ALREADY HAS a spec doc, shown verbatim below. Your task is a REVISION of it, not a from-scratch rewrite: apply the requested changes, keep everything else intact (the user may have already reviewed and accepted the rest), and re-verify against the repo only where the change requires it. Your final message must be the COMPLETE revised spec document — it replaces the doc wholesale. If the existing spec does not follow the two-section structure mandated below ("## User-facing changes" / "## Technical implementation"), reorganize it into those two sections as part of this revision while preserving its content.

==== CURRENT SPEC DOC (revise this) ====

${existingSpec}

==== END CURRENT SPEC DOC ====`
    : '';

  // Scout-specific prompt. Deliberately omits the platform-conventions
  // block and commit/push instructions used in the build prompt — scout
  // never edits anything. The "final message is the spec" contract is
  // load-bearing: we extract `result.lastResultText` verbatim and store
  // it as spec_md, so any preamble would leak into the user's spec.
  const scoutPrompt = `SCOUT TASK (from the Mayor):
${toolPromptArg}

USER REQUEST: "${userMessage}"

You are running in PLAN MODE: you can read files (Read, Glob, Grep) but you cannot edit, commit, or push anything. Do not attempt to.${revisionBlock}

A read-only helper \`usernode-issues\` is available (run it via Bash) — it prints the repo's open GitHub issues as JSON (\`{ issues: [{ number, title, body, labels, updatedAt, htmlUrl }], truncatedList }\`); long bodies are clipped with a "[truncated …]" marker, and \`usernode-issues <number>\` fetches that one issue with its FULL body (\`{ issue, note? }\`). Use it if the open issues are relevant context for this spec; do not try to reach GitHub any other way.

Your job is to investigate this repo and produce a MARKDOWN SPEC for the change. The spec should be:
- A complete, self-contained markdown document the user can review on its own.
- Grounded in real file evidence — reference actual file paths and current behaviour, not guesses.
- Structured as TWO halves under these exact H2 headings, in this order: "## User-facing changes" then "## Technical implementation". The spec viewer renders the two halves as tabs, so content outside them is undesirable — keep everything except the title and an optional 1-2 sentence summary inside one of the two halves. "User-facing changes" must be readable by a non-developer: describe what the user will see and do differently (screens, behaviour, before/after) — no file paths, no schema, no code. "Technical implementation" holds everything else: affected files, data model, edge cases, tests, considerations, deferred work. All other headings must be ### or deeper — no other ## headings anywhere in the document.
- Specific enough that a coding agent could implement it without re-doing your investigation, but NOT a literal diff or code block.
- If the planned change introduces data-dependent UI (lists, threads, leaderboards, anything that renders rows), the "Technical implementation" half should name the staging seed data the build will need (per the "Staging mock data" platform convention), so seeding is planned rather than improvised at build time.

The spec is rendered as markdown in a viewer that follows standard CommonMark fencing. If you include a fenced code block that ITSELF contains a triple-backtick fence (common when quoting markdown examples or the platform's \`\`\`filepath:...\`\`\` output convention), wrap the OUTER block in a four-backtick fence (\`\`\`\`) — a longer fence can safely contain shorter ones. Otherwise the inner \`\`\` closes the block early and the rest of the spec renders broken. When in doubt, prefer fewer/inline code samples over deeply nested fences.

Do NOT pad the spec with open questions. Only include a "### Questions" subsection — placed at the END of the "User-facing changes" half, since questions are for the (possibly non-technical) requester — for things that genuinely BLOCK implementation: decisions the coding agent cannot reasonably make on its own and that would change what gets built. Make a sensible default choice wherever you can and state it, rather than asking. Non-blocking items — things worth noting but not required to answer before building — belong in the "Technical implementation" half under "### Considerations" (trade-offs, assumptions, things to keep in mind) or "### Deferred work" (out-of-scope or follow-up items), NOT as questions. When there are no blockers, OMIT the "### Questions" subsection entirely — do NOT write "### Questions\nNone" or an empty section.

Your final assistant message must be ONLY the markdown spec — no preamble, no "I'll investigate...", no "Here's the spec:". The host captures that final message verbatim and stores it as the session's spec doc.

CRITICAL: Output the spec as RAW markdown. Do NOT wrap your whole response in a code fence — no leading \`\`\`markdown line and no trailing \`\`\`. A whole-document fence makes the spec render as one big code block instead of formatted markdown. Fences are only for actual code/quoted snippets INSIDE the spec.${headless ? `

HEADLESS RUN (#178): this spec is being drafted unattended for a GitHub issue — no human is available to answer questions during the run. If the Mayor's instructions list ambiguities or unresolved points, resolve them from the code BEFORE considering them open: read the relevant files, state what the code shows, and choose a sensible default where one exists. Any "### Questions" section you do write (at the end of the "User-facing changes" half) will be relayed verbatim to the issue reporter as a GitHub comment, so it must contain ONLY questions a codebase cannot answer (product intent, preferences, reproduction details), each self-contained, numbered, and carrying your suggested default.` : ''}`;

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
  // signal travels through worker.stopTurn (in-container pkill) so the
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
      const dispatchScout = () => worker.execInWorker(session.id, {
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
      });
      result = await dispatchScout();
      // Headless auto-retry: a markerless turn that produced no spec text
      // gets exactly one re-dispatch (the retry wraps the call site, not
      // execInWorker, so active_turn bookkeeping stays per-attempt).
      if (headless && shouldRetryHeadlessTurn(result, stopHandle, !!(result.lastResultText || '').trim())) {
        await sendStatus('The coding step failed unexpectedly — retrying once…');
        await waitForTurnStopped(session.id, containerName);
        result = await dispatchScout();
      }
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
      await sendStatus(`Scout stopped${byStr}.`, { durationMs: Date.now() - turnStartedMs });
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
      // Markerless exits (exitCode -1, or null — never normalized) mean
      // the run died, not that the scout chose to write nothing.
      const msg = (result.exitCode === -1 || result.exitCode == null)
        ? `${describeMarkerlessExit(result.markerlessCause)} No spec text was produced.`
        : 'Scout finished but produced no spec text.';
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
        existingSpec
          ? `Scout revised the spec (now ${lineCount} lines).`
          : `Scout drafted a ${lineCount}-line spec from the codebase.`,
        { specPreview: preview, specLines: lineCount, scoutOutput: ccText, specVersion, durationMs: Date.now() - turnStartedMs }
      );
      send('spec_updated', { length: ccText.length, lines: lineCount, version: specVersion });
      summaryParts.push(
        existingSpec
          ? `The scout revised the session's spec doc (now ${lineCount} lines). `
            + `The user can review it in the dev-chat spec viewer. When they're ready to ship, they'll ask you to dispatch the coding agent.`
          : `The scout investigated the repo and drafted a ${lineCount}-line markdown spec. `
            + `It now lives in the session's spec doc; the user can review it in the dev-chat spec viewer. When they're ready to ship, they'll ask you to dispatch the coding agent.`
      );
    }

    if (result.costUsd) {
      const ccCostCents = Math.round(result.costUsd * 100);
      // Scout costs land in the same llm_usage table as build dispatches —
      // they're real Anthropic spend on the same daily budget.
      await limits.recordSpend(pool, req.user.id, ccCostCents, { byok: !!userApiKey });
      send('usage', { costCents: ccCostCents, model: `scout/${selectedModel}`, byok: !!userApiKey });
    }
  } finally {
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
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

// Plain-terms explanation of a markerless turn (worker exitCode -1 / null
// — the detached wrapper never wrote its __USERNODE_EXIT__ line). The
// cause tag is set by worker.js's journal consumer; the bare
// "exited with code -1" wording is deliberately gone (it read like a
// Claude Code failure when the agent was usually healthy).
function describeMarkerlessExit(cause) {
  switch (cause) {
    case 'oom_killed':
      return 'The coding agent was killed — most likely it ran out of memory.';
    case 'container_gone':
      return "The coding agent's worker container disappeared mid-run.";
    case 'probe_unobservable':
      return "The platform lost contact with the coding agent's run.";
    case 'turn_process_gone':
      return "The coding agent's process ended without reporting a result.";
    default:
      return "The coding agent's run ended without reporting a result.";
  }
}

// One automatic retry for headless scout/build turns that died without
// producing anything: markerless exit, no __USERNODE_RESULT__ line, and
// no per-mode output (commit for build, spec text for scout — the caller
// passes that as `producedOutput`). Interactive turns stay single-shot —
// a human is present to re-dispatch — and a user-stopped turn is a
// deliberate end, not a failure to retry.
function shouldRetryHeadlessTurn(result, stopHandle, producedOutput) {
  if (!result || producedOutput) return false;
  if (stopHandle && stopHandle.stopped) return false;
  return result.exitCode === -1 && !result.resultSeen;
}

// Pre-retry safety: kill any zombie turn process and wait (bounded) for
// the container to probe idle, so the re-dispatch can't race two claudes
// in one container (the new wrapper's `rm -f turn-*.log` only runs once
// the old turn is confirmed dead). Returns whether idle was confirmed;
// the caller retries either way — worst case the dispatch itself fails.
async function waitForTurnStopped(sessionId, containerName, { timeoutMs = 30000 } = {}) {
  try { await worker.stopTurn(sessionId); } catch {}
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await worker.isWorkerExecuting(containerName);
    if (busy === false) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 2000));
  }
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
// Tailored remediation per staging-failure class. The `fix` text ends up
// in the Mayor's tool_result and on the user's screen, so it has to be
// self-contained: the Mayor doesn't read code, and the user shouldn't
// have to either. Keep prose short but concrete enough that
// "dispatch_claude_code" + this message is sufficient to drive an
// automated fix on the next turn. Shared by the interactive tail (where
// the failure is fatal to the turn) and the headless tail (#183, where
// it's non-fatal — the pushed commit is the deliverable).
function describeStagingFailure(stagingErr) {
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

  // Defensive: if buildAndDeployStaging ever returned null/undefined
  // without throwing (it shouldn't — its contract is throw-or-return-
  // result), stagingErr would be null here. Coerce so callers still emit
  // a meaningful event instead of NPE'ing.
  const errMsg = (stagingErr && stagingErr.message) || 'Unknown staging failure (no error thrown but no result returned)';
  const errName = (stagingErr && stagingErr.name) || 'Error';
  return { fix, missingKeys, errMsg, errName };
}

async function runClaudeCodeTool({
  pool, config, req, res, session, selectedModel,
  userMessage, toolPromptArg,
  repoOwner, repoName,
  send, sendStatus,
  stopHandle,
  userApiKey,
  // #155/#183: headless auto sessions may commit + push their branch and
  // deliberately build a staging preview, but must NOT open a PR — that
  // happens later, lazily, when a dev chat cloned off the auto session is
  // proposed to the group. Swaps the success-path tail for the headless
  // variant (staging, no PR); everything else (worker exec, push
  // accounting, cost debit) is identical.
  headless = false,
}) {
  activeWorkers.add(session.id);
  // #50: wall-clock start for the durationMs persisted on terminal
  // statuses, so the dev-chat "(took Xm Ys)" suffix survives reloads.
  const turnStartedMs = Date.now();
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

A read-only helper \`usernode-issues\` is available (run it via Bash) — it prints the repo's open GitHub issues as JSON (\`{ issues: [{ number, title, body, labels, updatedAt, htmlUrl }], truncatedList }\`); long bodies are clipped with a "[truncated …]" marker, and \`usernode-issues <number>\` fetches that one issue with its FULL body (\`{ issue, note? }\`). Consult it if an open issue is relevant to what you're building; do not try to reach GitHub any other way.

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
path: /another/changed/view
1. First step a tester should take.
2. What they should see if the change works.
==== END TESTING ====

  Rules for the testing block:
  - The "path:" line points the before/after screenshots (and the "Test
    this change" button) at the route where the change is visible. Each
    must be a RELATIVE path within the app (starts with "/", no scheme or
    host).
  - REQUIRED for user-visible changes that are NOT on the app's root: you
    MUST include at least one "path:" pointing at the view where the change
    shows up. Otherwise the screenshots default to the home page and show a
    screen your change never touched. Only omit "path:" when the change
    genuinely lives on "/" (the home page is the right place to start).
  - You may give MORE THAN ONE "path:" line (one per line, up to 3,
    captured in the order written) when the change spans several views —
    e.g. a new nav item plus the page it opens. Each becomes its own
    labelled before/after row. The FIRST path is also the deep link the
    "Test this change" button jumps to.
  - SELF-APP (social-vibecoding) ONLY: this app is a hash-routed SPA — its
    internal screens live in the URL fragment ("#app/<slug>/dev/...",
    "#leaderboard"), NOT in the server pathname. Write the "path:" using
    the in-app route segments exactly as they appear after the "#"
    (e.g. "path: /app/<self-slug>/dev/proposals/<id>" or
    "path: /leaderboard") — the platform moves it into the fragment when
    capturing screenshots and when the "Test this change" button opens the
    preview, so the shot lands on the changed screen instead of the home
    feed. Standalone server pages ("/dashboard", "/admin", "/status",
    "/node-status") stay as plain pathnames. (This only applies to the
    self-app; ordinary apps are path-routed and need no special handling.)
  - The steps are short markdown (numbered list preferred), written for a
    non-technical tester looking at a staging preview seeded with a copy of
    production data.
  - DATA AVAILABILITY: before writing the steps, check what each step's
    data actually looks like in staging — existing public tables carry a
    copy of production data, but tables created by THIS change and
    staging:private tables are EMPTY. If a step needs data that won't
    exist, you MUST seed it in this same commit per the "Staging mock
    data" convention above (IS_STAGING boot-time seed, or a
    staging-gated ?demo=1 route — always a no-op in production), and
    write the steps against the seeded entities by name ("Open the
    thread 'Staging demo thread' and …"). Point "path:" at a view where
    the seeded data is visible (or at the ?demo=1 route). Changes
    testable purely against production-cloned data need no seeding.
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
  // actual stop signal flows through worker.stopTurn (in-container
  // pkill) so the warm container is preserved across stop — eviction is
  // the only path that destroys it.
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

    // Experimental AI progress estimate: while the per-user toggle is ON,
    // a 60s base ticker asks Haiku to skim the progress-log tail and emits
    // a vague "AI guess" via send('cc_estimate'). Gated hard: never for
    // headless turns (no live watcher), never without an LLM client, and
    // the whole block is skipped when the toggle is off — degradation to
    // today's behavior is structural, not a runtime branch. Estimates are
    // ephemeral (in-memory + SSE only, never persisted).
    //
    // Reliability for long runs (#323): the estimator no longer dies
    // permanently after a few failures or a flat emit count. Transient
    // Haiku errors trigger a short tick-skip backoff that resets on the
    // next success, and the cadence widens with elapsed time instead of
    // stopping — so a 12+ minute run keeps getting refreshed guesses. The
    // first guess fires even before any progress line lands, and the
    // remaining-time countdown is re-asked on a wall-clock cadence so it
    // never freezes during a long quiet phase (one slow command/edit).
    const estimatorEnabled = !headless && !!req?.user?.aiProgressEstimate
      && (llm.isEnabled() || !!userApiKey);
    const liveProgressLines = [];
    let estimator = null;
    // Diagnose the silent-disable case: toggle ON + live turn but no LLM
    // key path means the user sees nothing with no obvious reason (#323).
    if (!headless && !!req?.user?.aiProgressEstimate && !estimatorEnabled) {
      log.warn('chat', 'AI progress estimate skipped: no LLM key available', {
        sessionId: session.id, userId: req.user.id,
      });
    }
    if (estimatorEnabled) {
      log.info('chat', 'AI progress estimator started', { sessionId: session.id });
      let estimateInFlight = false;
      let linesAtLastEstimate = 0;
      let consecutiveFailures = 0;   // drives the backoff window
      let ticksToSkip = 0;           // remaining backoff ticks to wait out
      let estimateSuccesses = 0;     // counted only for the runaway backstop
      let lastEstimateAtMs = null;   // wall-clock of the last successful emit
      let ceilingLogged = false;
      // Runaway backstop only — with the widening cadence below this is
      // reached around the ~2h mark, never by a normal long run.
      const MAX_ESTIMATES = 60;
      // After this much elapsed time the cadence widens (cost containment
      // on genuinely long runs); below it we stay at the 60s base tick.
      const WIDEN_AFTER_MS = 15 * 60_000;
      const WIDE_SPACING_MS = 150_000;   // ~2.5 min minimum spacing late in a run
      const IDLE_REFRESH_MS = 180_000;   // re-ask even with no new lines so ~X left moves
      const CC_ACTION_RE = /^(Reading |Writing |Editing |\$ |Using )/;
      estimator = setInterval(() => {
        // One call in flight at a time.
        if (estimateInFlight) return;
        // Runaway backstop: stop for good only on a pathological multi-hour
        // run. Logged once so it's diagnosable, then the timer is torn down.
        if (estimateSuccesses >= MAX_ESTIMATES) {
          if (!ceilingLogged) {
            ceilingLogged = true;
            log.info('chat', 'AI progress estimator hit emit ceiling', {
              sessionId: session.id, estimates: estimateSuccesses,
            });
          }
          clearInterval(estimator);
          return;
        }
        // Backoff after failures: wait out the skip window, then retry. The
        // counter resets on the next success so a transient blip can't
        // disable estimates for the rest of a long run.
        if (ticksToSkip > 0) { ticksToSkip--; return; }

        const now = Date.now();
        const elapsedMs = now - turnStartedMs;
        const hasNewLines = liveProgressLines.length !== linesAtLastEstimate;
        const sinceLastMs = lastEstimateAtMs == null ? Infinity : now - lastEstimateAtMs;
        const minSpacingMs = elapsedMs >= WIDEN_AFTER_MS ? WIDE_SPACING_MS : 0;

        // Decide whether to run this tick:
        //  - first estimate ever: always (even with zero lines — the prompt
        //    renders "(no output yet)" and answers "still early …");
        //  - too soon under the widened late-run cadence: skip;
        //  - new progress since last estimate: run;
        //  - otherwise idle-refresh once enough wall-clock passed so the
        //    remaining-time guess doesn't freeze during a quiet phase.
        let shouldRun;
        if (lastEstimateAtMs == null) shouldRun = true;
        else if (sinceLastMs < minSpacingMs) shouldRun = false;
        else if (hasNewLines) shouldRun = true;
        else shouldRun = sinceLastMs >= IDLE_REFRESH_MS;
        if (!shouldRun) return;

        estimateInFlight = true;
        const linesAtStart = liveProgressLines.length;
        llm.estimateRunProgress({
          userRequest: userMessage,
          progressTail: liveProgressLines,
          elapsedMs,
          steps: liveProgressLines.filter((l) => CC_ACTION_RE.test(l)).length,
          apiKey: userApiKey || undefined,
        }).then(async ({ text, remainingSeconds, usage, model: estModel }) => {
          consecutiveFailures = 0;
          ticksToSkip = 0;
          estimateSuccesses++;
          linesAtLastEstimate = linesAtStart;
          lastEstimateAtMs = Date.now();
          const elapsedAtEstimate = lastEstimateAtMs - turnStartedMs;
          // A call resolving after the user hit stop is dropped — the
          // running line is already deactivated client-side.
          if (!(stopHandle && stopHandle.stopped)) {
            send('cc_estimate', { text, remainingSeconds, elapsedMs: elapsedAtEstimate });
            workerProgress.setEstimate(session.id, { text, remainingSeconds });
            // Persist this tick to the accuracy dataset (#50 follow-up).
            // Fire-and-forget: persistence must never fail or block a turn,
            // matching the progressLog UPDATE posture below. The turn's
            // actual outcome is backfilled at the terminal choke point.
            pool.query(
              `INSERT INTO progress_estimates
                 (session_id, progress_message_id, user_id, model,
                  elapsed_ms, step_count, progress_lines,
                  estimate_text, predicted_remaining_seconds)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                session.id, progressMsgId, req.user.id, estModel,
                elapsedAtEstimate,
                liveProgressLines.filter((l) => CC_ACTION_RE.test(l)).length,
                liveProgressLines.length,
                text, remainingSeconds,
              ]
            ).catch(() => {});
          }
          if (usage) {
            const cents = llm.estimateCostCents(usage, estModel);
            await limits.recordSpend(pool, req.user.id, cents, { byok: !!userApiKey });
          }
        }).catch((err) => {
          // Self-healing backoff: skip up to 5 ticks (~5 min) after repeated
          // failures, but never stop for good — the next success resets it.
          consecutiveFailures++;
          ticksToSkip = Math.min(consecutiveFailures, 5);
          log.warn('chat', 'AI progress estimate failed; backing off', {
            sessionId: session.id, err: err.message,
            consecutiveFailures, ticksToSkip,
          });
        }).finally(() => {
          estimateInFlight = false;
        });
      }, 60_000);
    }

    let result;
    try {
      const dispatchBuild = () => worker.execInWorker(session.id, {
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
          if (estimatorEnabled) liveProgressLines.push(text);
          pool.query(
            `UPDATE chat_session_messages SET metadata = jsonb_set(
              metadata, '{progressLog}',
              (COALESCE(metadata->'progressLog', '[]'::jsonb) || $1::jsonb)
            ) WHERE id = $2`,
            [JSON.stringify([text]), progressMsgId]
          ).catch(() => {});
        },
      });
      result = await dispatchBuild();
      // Headless auto-retry: a markerless turn that committed nothing
      // gets exactly one re-dispatch (the retry wraps the call site, not
      // execInWorker, so active_turn bookkeeping stays per-attempt).
      if (headless && shouldRetryHeadlessTurn(result, stopHandle, result.ahead > 0)) {
        await sendStatus('The coding step failed unexpectedly — retrying once…');
        await waitForTurnStopped(session.id, containerName);
        result = await dispatchBuild();
      }
    } finally {
      clearInterval(heartbeat);
      if (estimator) clearInterval(estimator);
      // Backfill the actual outcome onto this turn's estimate rows (#50
      // follow-up). Single choke point: the turn's wall clock is known
      // here and the interval is being torn down. Per-tick ground-truth
      // remaining = actual_total_ms - that tick's elapsed_ms. Outcome is
      // derived from the turn result: stopped > error > committed > noop.
      // Guarded on estimatorEnabled so non-opted runs do nothing, and
      // fire-and-forget so a DB hiccup never affects the run.
      if (estimatorEnabled) {
        const durationMs = Date.now() - turnStartedMs;
        const outcome = (stopHandle && stopHandle.stopped) ? 'stopped'
          : (!result || result.isError) ? 'error'
          : (result.ahead > 0 && result.sha) ? 'committed'
          : 'noop';
        pool.query(
          `UPDATE progress_estimates
              SET actual_total_ms = $1,
                  actual_remaining_ms = $1 - elapsed_ms,
                  outcome = $2,
                  resolved_at = NOW()
            WHERE progress_message_id = $3 AND actual_total_ms IS NULL`,
          [durationMs, outcome, progressMsgId]
        ).catch(() => {});
      }
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
      await sendStatus(`Claude Code stopped${byStr}.`, { durationMs: Date.now() - turnStartedMs });
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
      let msg;
      if (result.exitCode === 0) {
        msg = 'No changes were made by Claude Code.';
      } else if (result.exitCode === -1 || result.exitCode == null) {
        // Markerless turn — say WHY in plain terms instead of a bare
        // "-1" (which also normalizes the old "code null" rendering).
        msg = `${describeMarkerlessExit(result.markerlessCause)} No changes were made.`;
      } else {
        msg = `Claude Code exited with code ${result.exitCode} — no changes were made.`;
      }
      await sendStatus(msg);
      summaryParts.push(msg);
    } else if (headless) {
      // Success path, headless variant (#155/#183): the commit was already
      // pushed by run-cc.sh inside the worker. Persist testing guidance so
      // it carries into cloned sessions, then deliberately build a staging
      // preview so reviewers can try the change before (or without)
      // cloning — while still skipping PR creation. The PR is opened
      // lazily on a CLONE's branch when its owner hits "Propose to group"
      // (routes/votes.js); the auto branch itself never gets a PR.
      if (!result.pushOk) {
        await sendStatus('Warning: push reported a failure — the branch may be stale.');
        summaryParts.push('Push reported a failure; the branch may be missing the commit.');
      }
      summaryParts.push(`Commit ${commitHash.substring(0, 8)} pushed to ${session.branch_name}.`);
      if (testing.testingMd || testing.testingPath) {
        await pool.query(
          `UPDATE chat_sessions SET testing_md = $1, testing_path = $2, testing_paths = $3 WHERE id = $4`,
          [testing.testingMd, testing.testingPath, JSON.stringify(testing.testingPaths || []), session.id]
        ).catch((err) => log.warn('sessions', 'Failed to persist testing guidance', { sessionId: session.id, err: err.message }));
        session.testing_md = testing.testingMd;
        session.testing_path = testing.testingPath;
        session.testing_paths = testing.testingPaths || [];
      }
      await sendStatus('Changes committed and pushed (headless) — building staging preview (no PR yet)...');

      const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
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
        // Same cert pre-warm as the interactive tail: persist staging_url
        // first (Caddy's `ask` gate keys off it), warm before revealing
        // the preview anywhere.
        await staging.warmStagingCert(session, stagingResult.hostname, stagingResult.stagingUrl);
        stagingUrl = stagingResult.stagingUrl;
        // The stagingUrl metadata is what makes this row render as the
        // "Changes ready" staging card (Preview / Test / Propose buttons)
        // in every dev chat later cloned from this auto session. The
        // explicit `changesReady: true` flag is what now DRIVES the card
        // (rather than incidentally `stagingUrl`), so the card renders the
        // same whether or not staging succeeded — see the failure branch.
        await sendStatus('Staging preview built', { stagingUrl, changesReady: true, prNumber: null });
        send('staging_ready', {
          url: stagingUrl,
          changesReady: true,
          testingMd: session.testing_md || null,
          testingPath: session.testing_path || null,
        });
        summaryParts.push(`Staging preview deployed: ${stagingUrl}`);

        // #195: before/after visuals. Fire-and-forget AFTER staging_ready
        // so the preview button is never delayed; captureForSession owns
        // the UI-affecting heuristic and swallows every failure. No PR
        // exists on the headless path — the stored artifacts surface in
        // the PR body later via applyPrMetadata at promote time.
        visuals.captureForSession(config, session, app, commitHash, stagingResult, { send })
          .catch((err) => log.warn('visuals', 'Headless capture failed (non-fatal)', {
            sessionId: session.id, err: err.message,
          }));
      } else {
        // Non-fatal (#183): the pushed commit is this run's deliverable; a
        // missing preview only degrades the review experience. Same
        // tailored remediation as the interactive tail so manifest/secret
        // problems surface in the Mayor's wrap-up summary — but isError
        // stays false and the run's outcome is unchanged.
        const { fix, missingKeys, errMsg, errName } = describeStagingFailure(stagingErr);
        // The commit IS pushed and reviewable — `changesReady: true` makes
        // the "Changes ready" card render (with a disabled Preview button +
        // missing-secret hint) on any clone, exactly as the success branch
        // does, instead of leaving a card-less "build failed" line. Headless
        // never opens a PR, so prNumber/prUrl are null.
        await sendStatus('Staging build failed', {
          error: errMsg,
          changesReady: true,
          stagingFailed: true,
          stagingErrorName: errName,
          stagingMissingKeys: missingKeys,
          prNumber: null,
        });
        send('staging_failed', {
          error: errMsg,
          errorName: errName,
          missingKeys,
          changesReady: true,
          prNumber: null,
        });
        summaryParts.push(
          `Staging preview failed to build (non-fatal — commit ${commitHash.substring(0, 8)} is pushed; `
          + `a preview can be built from a cloned session).\n\n${fix}`
        );
        log.error('staging', 'Headless staging build failed (non-fatal)', {
          sessionId: session.id, slug: app.slug, errName, err: errMsg, missingKeys,
        });
      }

      summaryParts.push(
        'Headless mode: no PR was opened. A user can start a dev-chat session from this auto session '
        + 'to review the change and propose it to the group — the PR is created on their cloned branch at propose time.'
      );
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
          `UPDATE chat_sessions SET testing_md = $1, testing_path = $2, testing_paths = $3 WHERE id = $4`,
          [testing.testingMd, testing.testingPath, JSON.stringify(testing.testingPaths || []), session.id]
        ).catch((err) => log.warn('sessions', 'Failed to persist testing guidance', { sessionId: session.id, err: err.message }));
        session.testing_md = testing.testingMd;
        session.testing_path = testing.testingPath;
        session.testing_paths = testing.testingPaths || [];
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
        // `changesReady: true` is now what drives the "Changes ready" card
        // (rather than incidentally `stagingUrl`), so the same card renders
        // on the staging-failed branch below. prNumber/prUrl ride along so
        // the card header + "View on GitHub" survive a reload from metadata.
        await sendStatus('Staging deployed!', {
          stagingUrl,
          changesReady: true,
          prNumber: session.pr_number || null,
          prUrl: session.pr_url || null,
        });
        // #127: ship the session's testing guidance (this turn's block, or
        // the kept-previous one off the session row) alongside the staging
        // URL so the client can offer "Test this change" without a refetch.
        send('staging_ready', {
          url: stagingUrl,
          changesReady: true,
          testingMd: session.testing_md || null,
          testingPath: session.testing_path || null,
        });
        summaryParts.push(`Staging redeployed: ${stagingUrl}`);

        // #195: before/after visuals. Fire-and-forget AFTER staging_ready
        // so the preview button is never delayed. When the capture lands
        // it patches the PR body's "Before / after" block directly and
        // emits visuals_ready (via this turn's send → SSE/WS/bus) so the
        // staging card upgrades in place.
        visuals.captureForSession(config, session, app, commitHash, stagingResult, { send })
          .catch((err) => log.warn('visuals', 'Capture failed (non-fatal)', {
            sessionId: session.id, err: err.message,
          }));

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
            const resetMsg = `Votes reset on PR #${session.pr_number || session.id} — new commit ${commitHash.substring(0, 8)} pushed.`;
            await sendSystemMessage(pool, session.app_id, resetMsg, 'system').catch(() => {});
            // Dual-post into the proposal's thread (lifecycle in context).
            await sendSystemMessage(pool, session.app_id, resetMsg, 'system',
              null, { type: 'session', ref: session.id }).catch(() => {});
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

        const { fix, missingKeys, errMsg, errName } = describeStagingFailure(stagingErr);

        const message =
          `Staging build failed.\n\n` +
          `What still happened: commit ${commitHash.substring(0, 8)} was pushed to ${session.branch_name}` +
          (session.pr_number ? ` and PR #${session.pr_number} was created/updated` : '') +
          `. Only the staging preview container is missing — there is no preview URL for this commit.\n\n` +
          fix;

        // The commit (and PR, if any) already landed — `changesReady: true`
        // keeps the "Changes ready" card + Propose button on screen (with a
        // disabled Preview button and the missing-secret hint), so a failed
        // preview no longer hides a perfectly proposable change. Propose
        // rebuilds staging itself (routes/votes.js), so this stays usable.
        await sendStatus('Staging build failed', {
          error: errMsg,
          changesReady: true,
          stagingFailed: true,
          stagingErrorName: errName,
          stagingMissingKeys: missingKeys,
          prNumber: session.pr_number || null,
          prUrl: session.pr_url || null,
        });
        send('staging_failed', {
          error: errMsg,
          errorName: errName,
          missingKeys,
          changesReady: true,
          prNumber: session.pr_number || null,
          prUrl: session.pr_url || null,
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

    // Debit the daily ledger for whatever Claude Code spent — even when
    // the run produced no commit (CC error, no-op turn, partial-failure
    // with `result.fatalError`). The Anthropic invoice is paid
    // regardless of whether code changes landed; without this we'd
    // silently let users burn budget on tool-only / failed turns and
    // only debit on the success branch. BYOK runs were billed to the
    // user's own key by the worker, so they land in the display-only
    // byok bucket instead of the capped one (#119 — this site used to
    // debit BYOK runs against the platform limit by mistake).
    if (result.costUsd) {
      const ccCostCents = Math.round(result.costUsd * 100);
      await limits.recordSpend(pool, req.user.id, ccCostCents, { byok: !!userApiKey });
      send('usage', { costCents: ccCostCents, model: `claude-code/${selectedModel}`, byok: !!userApiKey });
    }

    if (ccText) {
      // Outcome-aware completion row (#358): the green "Claude Code finished"
      // card + the [CODING AGENT COMPLETED] fold-in are reserved for runs
      // that actually changed code. A run that committed nothing (no-op) or
      // errored gets an honest header instead, and a ccOutcome discriminator
      // so buildMayorMessages labels the Mayor's context accordingly — a
      // no-op/failure must never masquerade as a completed build.
      const ccOutcome = hasChanges
        ? 'success'
        : ((result.fatalError || result.ccIsError) ? 'error' : 'no_changes');
      const statusText = ccOutcome === 'success'
        ? 'Claude Code finished'
        : ccOutcome === 'no_changes'
          ? 'Claude Code made no changes'
          : 'Claude Code did not complete';
      await sendStatus(statusText, { ccOutput: ccText, ccOutcome, durationMs: Date.now() - turnStartedMs });
      // Prepend CC's own description so the Mayor leads with what was
      // actually built, with our outcome bullets as supplementary context.
      summaryParts.unshift(`What the agent did:\n${ccText}`);
    }
  } finally {
    activeWorkers.delete(session.id);
    workerProgress.clear(session.id);
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

function getMayorSystemPrompt(appName, isWorkerBusy, currentSpec, selfHosted, prContext, openProposalsBlock = '') {
  const specIsEmpty = !((currentSpec || '').trim());

  const toolNote = isWorkerBusy
    ? `\n\nSTATUS: A coding agent IS currently running for this session — the dispatch_claude_code and dispatch_scout tools are NOT available right now. Just chat with the user; tell them the agent is still working and they can follow up once it finishes.`
    : `\n\nSTATUS: No coding agent is running. You MAY use dispatch_claude_code or dispatch_scout when appropriate (see the rules below). Otherwise just reply in text and do not call any tools.`;

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
  // turn so it can answer "what's in the spec?" accurately and write
  // precise revision prompts for the scout. Re-injected fresh before
  // each phase (see chat handler) so a scout dispatch earlier in the
  // same turn is reflected in phase-2.
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

  return `You are the Mayor — a friendly project manager for the app "${appName}" on Usernode Social Vibecoding.

YOUR ROLE:
You talk to the user in plain English and decide whether their latest message needs the coding agent (Claude Code) to actually edit the repo, OR needs spec-stage planning before any code is written. You are NOT a developer — never write code, file contents, diffs, or implementation details. Keep replies to 1-4 sentences.

THE SPEC DOC:
Every session has a markdown SPEC DOC that the user can read in the dev-chat spec viewer (a side-panel they open via the spec preview cards in the chat). It is your collaborative working surface for planning before code is written. The current spec is included verbatim below in the CURRENT SPEC DOC block — refer to it whenever you discuss or summarize the spec. The viewer is read-only: the user cannot hand-edit the spec, so all revisions go through you — and YOU never edit the spec in-process either. ALL spec writing and revising, however small, is done by dispatching the scout (dispatch_scout), which reads the repo and rewrites the doc; you only relay what the user wants changed. When they're happy with the spec they'll ask you to dispatch the coding agent in chat — you don't need to call dispatch_claude_code just because the spec is done; the user owns that decision.

SPEC QUESTIONS — KEEP THEM RARE:
Do not pad the spec with open questions. Only include a "Questions" section for things that genuinely BLOCK implementation — decisions the coding agent cannot reasonably make on its own and that would change what gets built. Wherever you can, make a sensible default choice and state it instead of asking. Non-blocking items belong under "Considerations" (trade-offs, assumptions, things to keep in mind) or "Deferred work" (out-of-scope or follow-up items) — never phrase those as questions. When there are no blockers, OMIT the "Questions" section entirely rather than writing "None" or an empty section. When you instruct the scout to write or revise the spec, tell it to prefer decisions over questions.

CLARITY GATE — ask before acting on unclear requests:
Before dispatching any tool on a request or issue, check whether it is clear enough to act on. A request/issue is UNCLEAR when any of these hold:
- It has multiple plausible interpretations that would produce materially different builds (which screen, which users, what should happen in case X).
- It's a bug report with no reproduction signal — no description of what was seen vs. expected, and no hint of where it happens.
- It references features, screens, or behavior that don't exist in the app, or contradicts itself.
- After reading it you cannot state the acceptance criteria ("done means…") in one sentence.
If a request is UNCLEAR, ask clarifying questions INSTEAD of calling any tool. Counter-rules so you don't over-ask:
- Never ask something the repo can answer — that's a dispatch_scout signal, not a question.
- Never ask when a sensible default exists — state the assumption in one sentence and proceed.
- Ask at most 3 numbered questions in a single message, each with your suggested default so a one-word reply ("defaults are fine") unblocks. Ask once — don't drip-feed questions across turns.
- When you DO ask clarifying questions, ALSO call the suggest_answers tool in the same message — one entry per question, in the same order as your numbered questions, with your suggested default as the FIRST answer — so the user can tap an answer chip instead of typing. Each answer must be a short, self-contained reply the user could send verbatim. suggest_answers is the ONLY tool allowed alongside questions.
- Never dispatch while also asking for clarification (asking and dispatching in the same turn is forbidden — suggest_answers accompanying a dispatch is dropped).
- If the user replies "your call" / "just do it", proceed with stated assumptions instead of re-asking.

TWO TOOLS, in priority order:

1) dispatch_scout(prompt) — read-only repo investigation + ALL spec writing, slow (~30-60s)
   Use for ALL spec work in a session: the first substantive draft AND every later revision, large or small. The scout is the coding agent in read-only mode: it reads files (Read/Glob/Grep), writes prose, and is structurally forbidden from editing or committing. Output replaces the session's spec doc.
   ${specIsEmpty ? 'The spec is currently empty — your first dispatch_scout drafts it from scratch.' : 'A spec already exists (see CURRENT SPEC DOC below). When the user asks for a revision — even a one-line tweak — dispatch the scout with a prompt describing exactly what to change; the current spec is auto-injected into its context, so do NOT restate the spec, just describe the delta. The scout revises the doc and preserves the rest.'}
   Heuristic: if your reply would be "I'd need to look at the code to answer that", that's a dispatch_scout signal — not an excuse to guess.
   You have NO in-process spec-edit tool — never draft or paste spec content into chat yourself; route every spec change through dispatch_scout.

2) dispatch_claude_code(prompt) — full coding agent, slow + writes code
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
- If the request fails the CLARITY GATE above, ask clarifying questions (per its rules) INSTEAD of calling any dispatch tool — the one tool that belongs WITH questions is suggest_answers. Never dispatch while also asking for clarification.
- At most ONE tool call per user message (suggest_answers accompanying your clarifying questions does not count toward this limit).
- Never call dispatch_scout and dispatch_claude_code in the same turn. The user dispatches the build themselves.

SUGGESTED QUICK REPLIES (suggest_replies):
On a normal reply and on the post-build/post-spec wrap-up, ALSO call the suggest_replies tool with 2-3 short, first-person messages the user is likely to want to send next — they render as tappable pills above the message box and PREFILL the box when tapped (the user can edit before sending), so each must read as a complete message the user could send verbatim. Tailor them to the current state:
- After a build (dispatch_claude_code): e.g. "Preview the change", "Propose it to the group", "Make another tweak".
- After a spec (dispatch_scout): e.g. "Build it", "Revise the spec", "What will this change?".
- A build is still running: e.g. "How's it going?", "Stop this build".
- A normal chat reply: the couple of likeliest next things to ask for.
suggest_replies is for NEXT-STEP shortcuts only — it is NOT for clarifying questions (those use suggest_answers). Never emit suggest_answers and suggest_replies in the same turn. Like suggest_answers, it does NOT count against the one-tool-per-message limit and may accompany a normal reply or wrap-up.

AFTER A TOOL RETURNS:
You'll get a short summary of what happened. Write a 1-3 sentence reply to the user in plain English, referencing the spec doc / staging URL / PR if present. For dispatch_scout: tell them the spec was drafted (or revised) and is available in the spec viewer. For dispatch_claude_code: summarize what was built. If anything failed, explain briefly and suggest next steps.
- IMPORTANT — spec→build handoff: after dispatch_scout, the spec is only PLANNED, not built. End your reply with a one-line next step that makes this explicit, e.g. "When this looks right, just tell me to build it and I'll have the coding agent implement it." Nothing gets built until the user asks — don't let a finished spec read as a finished change. (After dispatch_claude_code the change IS built, so no handoff line is needed.)

STAGING BUILD FAILURES (recoverable):
A dispatch_claude_code tool_result may report that the commit/push/PR succeeded but the staging preview failed to build. The two common causes — both surfaced verbatim in the tool_result with explicit "Fix:" instructions:
  * Missing \`staging_default\` for a private secret in dapp.json — the agent CAN fix this directly. Acknowledge the issue to the user, propose the concrete fix in one sentence (e.g. "I'll add \`staging_default: \"\"\` to SENDER_APP_SECRET_KEY since the app degrades gracefully without it"), and on the user's next confirmation call dispatch_claude_code with a prompt naming the keys and the value to use.
  * Missing required secret in the platform secret store — the agent CANNOT fix this; the user (or admin) needs to set the value in Settings → Secrets. Tell them which key, point them at the Settings UI, and offer to retry once it's set.
For other staging failures (Docker build, network, image cache), explain briefly and offer to retry. Do NOT pretend a failed staging build succeeded — the user can see the build status in the chat.

HISTORY CONTEXT:
Some assistant turns in this conversation contain "${CODING_AGENT_COMPLETED_MARKER}:" — that is a summary from a PAST coding-agent run, written by the system, not by you. You may reference it when the user asks an INFORMATIONAL question about a past turn (e.g. "what did you do?", "why did you change X?", "what files were touched?") — quote or paraphrase to answer.

You MUST NOT, under any circumstances:
- Write the literal string "${CODING_AGENT_COMPLETED_MARKER}" in your reply. That marker is reserved for the harness; emitting it yourself fakes a coding-agent run that never happened.
- Paraphrase a past summary as a substitute for dispatching a new run. If the user reports a bug, regression, or "still not quite right" — even if a previous run targeted the same area — that is a NEW change request and you MUST call dispatch_claude_code (assuming the tool is available per STATUS). Past summaries are read-only history; they cannot fix new bugs.${toolNote}${conventionsBlock}${selfHosted ? getSelfHostedRefuseList() : ''}${prBlock}${openProposalsBlock || ''}${specBlock}`;
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

module.exports = { sessionRoutes, getActiveWorkerCount, runSyncMain, persistBehindMain, buildSpecPreview, buildOpenProposalsBlock, stripSpecWrapperFence, snapshotSessionSpec, resumeHeadlessRuns, notifySessionDone, notifyAutoSolveDone, buildHeadlessSeed, buildHeadlessDecisionAddendum, buildHeadlessFollowUpMessage, buildHeadlessFollowUpQuickReplies, shouldPostHeadlessQuestionComment, specHasBlockingQuestions, sanitizeSuggestedAnswers, resolveSuggestedAnswers, sanitizeQuickReplies, resolveQuickReplies, describeMarkerlessExit, shouldRetryHeadlessTurn, stripFakeCompletionMarker, buildMayorMessages, CODING_AGENT_COMPLETED_MARKER };
