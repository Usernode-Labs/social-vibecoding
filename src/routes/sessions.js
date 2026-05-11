'use strict';

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const llm = require('../services/llm');
const github = require('../services/github');
const prMetadata = require('../services/pr-metadata');
const staging = require('../services/staging');
const docker = require('../services/docker');
const caddy = require('../services/caddy');
const worker = require('../services/worker');
const workerProgress = require('../services/worker-progress');
const sessionBus = require('../services/session-bus');
const { drainGuard } = require('../services/lifecycle');
const { getAppConventions } = require('../services/prompts');

// Track sessions with active Claude Code workers
const activeWorkers = new Set();

// Per-session stop handles, populated while a chat turn is in flight.
// Shape: { abort: AbortController, workerName: string|null, phase: 'mayor1'|'cc'|'mayor2', stopped: boolean }
// The POST /stop endpoint looks up this record to:
//   1. Abort the in-flight Mayor Anthropic stream (phase 'mayor1').
//   2. `docker stop` the running Claude Code worker (phase 'cc').
// Phase 'mayor2' is intentionally stop-proof — by then CC has already
// pushed a commit + opened a PR and we just want the summary to finish.
const stopRegistry = new Map();

// Expose the in-flight worker set size so the main server can wait for
// active chats to finish before forcefully tearing down containers.
function getActiveWorkerCount() {
  return activeWorkers.size;
}

const USER_DAILY_LIMIT_CENTS = 2500;
const GLOBAL_DAILY_LIMIT_CENTS = 20000;

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

function sessionRoutes(config) {
  const router = Router();
  const pool = getPool(config);

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
                cs.status, cs.created_at,
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
      const { rows: appRows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [req.params.slug]);
      if (!appRows.length) return res.status(404).json({ error: 'App not found' });

      const { rows } = await pool.query(
        `SELECT id, branch_name, pr_number, pr_url, pr_title, staging_url, status, created_at
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
      const { rows: appRows } = await pool.query('SELECT * FROM apps WHERE slug = $1', [req.params.slug]);
      if (!appRows.length) return res.status(404).json({ error: 'App not found' });
      const app = appRows[0];

      // Check staging container limits
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions WHERE user_id = $1 AND status IN ('active', 'promoted')`,
        [req.user.id]
      );
      if (parseInt(countRows[0].cnt) >= 3) {
        return res.status(429).json({ error: 'You already have 3 active sessions. Pause, archive, or merge one first.' });
      }

      const { rows: globalRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions WHERE status IN ('active', 'promoted')`
      );
      if (parseInt(globalRows[0].cnt) >= 25) {
        return res.status(429).json({ error: 'Global staging limit reached. Try again later.' });
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

  // Archive a session
  router.post('/api/sessions/:id/archive', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE chat_sessions SET status = 'archived'
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'promoted', 'paused')
         RETURNING id`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found or already archived' });

      // Teardown staging container if any
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.repo_url FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id WHERE cs.id = $1`,
        [req.params.id]
      );
      if (sessionRows[0]?.staging_container_id) {
        await staging.teardownStaging(sessionRows[0], { slug: sessionRows[0].app_slug }).catch(() => {});
      }

      // Close the PR on GitHub
      const session = sessionRows[0];
      if (session?.pr_number) {
        try {
          const [, owner, repo] = (session.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
          if (owner && repo) {
            const octokit = await github.getInstallationOctokit(owner).catch(() => null);
            const pat = process.env.GITHUB_BOT_TOKEN;
            if (pat) {
              const { Octokit } = await import('@octokit/rest');
              const ok = new Octokit({ auth: pat });
              await ok.rest.pulls.update({
                owner, repo,
                pull_number: session.pr_number,
                state: 'closed',
              });
              log.info('sessions', 'PR closed', { pr: session.pr_number });
            }
          }
        } catch (err) {
          log.warn('sessions', 'Failed to close PR', { err: err.message });
        }
      }

      // Tear down the worker container. With long-lived workers, the
      // container can exist even when nothing is in flight (warm-idle
      // waiting for the next dispatch), so we always try destroyWorker
      // — it's a no-op if the container is already gone. activeWorkers
      // is only the in-flight set, not the warm-container set.
      const sessionId = parseInt(req.params.id);
      if (activeWorkers.has(sessionId)) {
        activeWorkers.delete(sessionId);
        workerProgress.clear(sessionId);
      }
      await worker.destroyWorker(`usernode-worker-${sessionId}`).catch(() => {});

      // Drop the persistent CC session volume — the chat is gone, so its
      // conversation memory shouldn't linger on disk.
      await worker.destroyCcVolume(sessionId).catch(() => {});

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'archived', sessionId, appSlug: session?.app_slug });
      log.info('sessions', 'Session archived', { sessionId });
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Archive failed', { message: err.message });
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
      const { rows } = await pool.query(
        `UPDATE chat_sessions SET status = 'paused'
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'promoted')
         RETURNING id, app_id`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) {
        // Either it doesn't exist, isn't ours, or is already paused/archived.
        // Surface a soft 200 if it's already paused so the UI can no-op the
        // button click; treat anything else as not found.
        const { rows: check } = await pool.query(
          `SELECT id, status FROM chat_sessions WHERE id = $1 AND user_id = $2`,
          [req.params.id, req.user.id]
        );
        if (check[0] && check[0].status === 'paused') return res.json({ ok: true, alreadyPaused: true });
        return res.status(404).json({ error: 'Session not found or cannot be paused' });
      }

      const sessionId = parseInt(req.params.id, 10);
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1`,
        [sessionId]
      );
      const session = sessionRows[0];

      if (session?.staging_container_id) {
        await staging.teardownStaging(session, { slug: session.app_slug }).catch(() => {});
      }

      // Drop in-flight bookkeeping so a paused session's old turn
      // doesn't hold the activeWorkers slot. destroyWorker is a no-op
      // if the container is already gone.
      if (activeWorkers.has(sessionId)) {
        activeWorkers.delete(sessionId);
        workerProgress.clear(sessionId);
      }
      await worker.destroyWorker(`usernode-worker-${sessionId}`).catch(() => {});

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'paused', sessionId, appSlug: session?.app_slug });
      log.info('sessions', 'Session paused', { sessionId });
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
  //   Enforces the same per-user 3-active-session cap as session
  //   creation — if the user is already at the cap, we 429 with a
  //   pointer to "pause something else first" rather than silently
  //   exceeding the cap. We deliberately do NOT pre-spawn the worker
  //   here; first-turn lazy boot is what every other path uses, so
  //   resume staying lazy keeps the behavior consistent.
  router.post('/api/sessions/:id/resume', async (req, res) => {
    try {
      const { rows: countRows } = await pool.query(
        `SELECT COUNT(*) as cnt FROM chat_sessions
         WHERE user_id = $1 AND status IN ('active', 'promoted')`,
        [req.user.id]
      );
      if (parseInt(countRows[0].cnt) >= 3) {
        return res.status(429).json({ error: 'You already have 3 active sessions. Pause one first to free a slot.' });
      }

      const { rows } = await pool.query(
        `UPDATE chat_sessions SET status = 'active'
         WHERE id = $1 AND user_id = $2 AND status = 'paused'
         RETURNING id, app_id`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Session not found or not paused' });

      const sessionId = parseInt(req.params.id, 10);
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
      res.json({ ok: true });
    } catch (err) {
      log.error('sessions', 'Resume failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Send a message in a dev chat session — Mayor + Claude Code pattern
  router.post('/api/sessions/:id/chat', drainGuard, async (req, res) => {
    const { message, model } = req.body;

    if (!message?.trim()) {
      return res.status(400).json({ error: 'Message required' });
    }

    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
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

      const selectedModel = model || 'claude-sonnet-4-6';

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
        const mayorPrompt = getMayorSystemPrompt(session.app_name, isWorkerBusy);
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
        // The Mayor sees three tools when no worker is busy. Their
        // priority ordering and the rule against combining write_spec
        // with dispatch_claude_code in one turn are enforced both by
        // the system prompt AND by the resolution code below — models
        // sometimes ignore prose constraints, so we belt-and-suspenders
        // it server-side.
        const tools = isWorkerBusy ? [] : [DISPATCH_TOOL, DISPATCH_SCOUT_TOOL, WRITE_SPEC_TOOL];

        setPhase('mayor1');
        let mayor1;
        try {
          mayor1 = await llm.streamChat({
            messages,
            systemPrompt: mayorPrompt,
            model: selectedModel,
            tools,
            signal: stopHandle.abort.signal,
            onToken: (text) => send('token', { text }),
            apiKey: userApiKey,
          });
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

        if (mayorText1.trim()) {
          send('mayor_reasoning', { text: mayorText1 });
          const costCents1 = llm.estimateCostCents(mayor1.usage, selectedModel);
          await pool.query(
            `INSERT INTO chat_session_messages (session_id, role, content, model, token_count, cost_cents)
             VALUES ($1, 'assistant', $2, $3, $4, $5)`,
            [session.id, mayorText1, selectedModel, mayor1.usage.input_tokens + mayor1.usage.output_tokens, costCents1]
          );
          // BYOK users pay Anthropic directly, so we don't track their
          // spend in `llm_usage` (that table drives the admin-key daily
          // cap). The per-message cost_cents above + the SSE 'usage'
          // event still give them live visibility into what each turn
          // cost on their own key.
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
        // enforcement: write_spec / dispatch_scout > dispatch_claude_code.
        // If the Mayor (mis)used multiple in one turn, we honor the
        // planning tool and quietly drop the dispatch — same rule the
        // tool descriptions state, but enforced here so a model regression
        // can't cause a surprise build mid-spec-discussion.
        const writeSpecCall = mayor1.toolUses.find((t) => t.name === 'write_spec');
        const scoutCall = mayor1.toolUses.find((t) => t.name === 'dispatch_scout');
        const dispatchCall = mayor1.toolUses.find((t) => t.name === 'dispatch_claude_code');

        let activeToolCall = null;
        let toolKind = null; // 'write_spec' | 'scout' | 'build'
        if (writeSpecCall) { activeToolCall = writeSpecCall; toolKind = 'write_spec'; }
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
        // container, so they share the same gate. write_spec is just a
        // DB UPDATE and bypasses the gate entirely.
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

        // --- Run the chosen tool ---
        let toolResult;
        if (toolKind === 'write_spec') {
          setPhase('spec');
          toolResult = await runWriteSpecTool({
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
        const followUpMessages = [
          ...messages,
          // Anthropic requires the assistant turn to be the VERBATIM
          // content blocks we got back, including the tool_use block —
          // otherwise the tool_result's tool_use_id doesn't resolve.
          { role: 'assistant', content: mayor1.rawContent },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: activeToolCall.id,
              content: toolResult.toolResultText,
              ...(toolResult.isError ? { is_error: true } : {}),
            }],
          },
        ];

        // Phase-2 is intentionally NOT abortable — CC has already
        // pushed a commit, opened the PR, and rebuilt staging. Stopping
        // the summary now would just leave the user without context for
        // real-world changes that already exist. The client hides the
        // stop button and shows a plain spinner during this phase.
        setPhase('mayor2');
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
            mayorText2 = toolKind === 'write_spec'
              ? "_The spec edit didn't go through — see the status above._"
              : toolKind === 'scout'
                ? "_The scout didn't finish successfully — see the status above._"
                : "_The coding agent didn't complete successfully — see the status messages above._";
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
  // The session has a live spec_md draft (overwritten by Mayor's
  // write_spec, by dispatch_scout, or by hand via PUT /spec) and an
  // append-only history in chat_session_specs (rows are frozen each
  // time the user clicks "Build from spec").
  //
  // Read-only fetch of the live draft. Returns metadata for past
  // versions so the dev-chat can populate its version selector without
  // a second round-trip; full content of past versions comes from
  // GET /specs/:version below.
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
  router.get('/api/sessions/:id/specs/:version', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    const version = parseInt(req.params.version, 10);
    if (Number.isNaN(sessionId) || Number.isNaN(version)) {
      return res.status(400).json({ error: 'Bad id/version' });
    }
    try {
      // Auth via session ownership join.
      const { rows } = await pool.query(
        `SELECT s.version, s.content, s.built_at, s.commit_sha, s.pr_number, s.shared_to_group_at
         FROM chat_session_specs s
         JOIN chat_sessions cs ON cs.id = s.session_id
         WHERE s.session_id = $1 AND s.version = $2 AND cs.user_id = $3`,
        [sessionId, version, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Spec version not found' });
      res.json({ spec: rows[0] });
    } catch (err) {
      log.error('sessions', 'Failed to get spec version', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/sessions/:id/specs
  //   Save the current chat_sessions.spec_md draft as a new immutable
  //   row in chat_session_specs. Triggered by the user clicking
  //   "Save version" in the spec viewer — the only writer of new rows
  //   in this table now (the legacy /build-spec route was removed in
  //   favor of letting the Mayor handle dispatches from chat).
  //
  //   Idempotent against rapid double-click: if the immediately-
  //   preceding version's content is byte-identical to the current
  //   draft, returns that existing row instead of inserting a
  //   duplicate. We compare ONLY against the most recent version, not
  //   the entire history, so the legitimate "AI rewrote, I reverted,
  //   I save again" flow still produces a fresh row at vN+1 carrying
  //   the same bytes as some earlier vK.
  //
  //   commit_sha and pr_number stay NULL — manually-saved rows aren't
  //   pinned to a git commit. Old rows from the legacy /build-spec
  //   route still carry their populated values; co-existence is fine
  //   and the UI degrades gracefully (PR link omitted when null).
  router.post('/api/sessions/:id/specs', async (req, res) => {
    const sessionId = parseInt(req.params.id, 10);
    if (Number.isNaN(sessionId)) return res.status(400).json({ error: 'Bad session id' });

    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.id, cs.spec_md
         FROM chat_sessions cs
         WHERE cs.id = $1 AND cs.user_id = $2`,
        [sessionId, req.user.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Session not found' });

      const content = sessionRows[0].spec_md || '';
      if (!content.trim()) {
        return res.status(400).json({ error: 'Cannot save an empty draft' });
      }

      const { rows: latestRows } = await pool.query(
        `SELECT version, content, built_at, shared_to_group_at
         FROM chat_session_specs
         WHERE session_id = $1
         ORDER BY version DESC
         LIMIT 1`,
        [sessionId]
      );
      if (latestRows.length && latestRows[0].content === content) {
        return res.json({
          version: latestRows[0].version,
          built_at: latestRows[0].built_at,
          char_count: content.length,
          shared_to_group_at: latestRows[0].shared_to_group_at,
          deduped: true,
        });
      }

      const nextVersion = latestRows.length ? latestRows[0].version + 1 : 1;
      const { rows: insertedRows } = await pool.query(
        `INSERT INTO chat_session_specs (session_id, version, content)
         VALUES ($1, $2, $3)
         RETURNING version, built_at`,
        [sessionId, nextVersion, content]
      );

      res.json({
        version: insertedRows[0].version,
        built_at: insertedRows[0].built_at,
        char_count: content.length,
        shared_to_group_at: null,
        deduped: false,
      });
    } catch (err) {
      log.error('sessions', 'Failed to save spec version', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

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
      const budget = await checkBudget(pool, req.user.id);
      const userSpent = USER_DAILY_LIMIT_CENTS - (budget.userRemaining || 0);
      res.json({
        spentCents: budget.error ? USER_DAILY_LIMIT_CENTS : userSpent,
        limitCents: USER_DAILY_LIMIT_CENTS,
        globalSpentCents: GLOBAL_DAILY_LIMIT_CENTS - (budget.globalRemaining || 0),
        globalLimitCents: GLOBAL_DAILY_LIMIT_CENTS,
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
            const octokit = await github.getInstallationOctokit(owner);
            const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${session.branch_name}` });
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

async function checkBudget(pool, userId) {
  const { rows: userRows } = await pool.query(
    `SELECT total_cost_cents FROM llm_usage WHERE user_id = $1 AND date = CURRENT_DATE`,
    [userId]
  );
  const userSpent = parseFloat(userRows[0]?.total_cost_cents || 0);
  if (userSpent >= USER_DAILY_LIMIT_CENTS) {
    return { error: `Daily limit reached ($${(USER_DAILY_LIMIT_CENTS / 100).toFixed(2)}). Resets at midnight UTC.` };
  }

  const { rows: globalRows } = await pool.query(
    `SELECT SUM(total_cost_cents) as total FROM llm_usage WHERE date = CURRENT_DATE`
  );
  const globalSpent = parseFloat(globalRows[0]?.total || 0);
  if (globalSpent >= GLOBAL_DAILY_LIMIT_CENTS) {
    return { error: 'Global daily limit reached. Try again tomorrow.' };
  }

  return { ok: true, userRemaining: USER_DAILY_LIMIT_CENTS - userSpent, globalRemaining: GLOBAL_DAILY_LIMIT_CENTS - globalSpent };
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
    + 'just chatting, brainstorming, asking about past work, or giving vague feedback. At most one call per user message.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'A clear, self-contained description of what the coding agent should build or fix. '
          + 'Should read like a task brief: what to change, where, and the expected user-visible behavior. '
          + 'Do NOT include code. Roughly 1-4 sentences.',
      },
    },
    required: ['prompt'],
  },
};

// Spec stage — read-only investigation. Runs CC in --permission-mode
// plan: it reads files, but cannot edit/commit/push. Output is captured
// as the session's spec_md doc, which the user can then review on the
// Spec tab and Build from. Slow (~30-60s container spinup) but
// authoritative — it's the only way for the Mayor to ground a spec in
// real file evidence rather than guess.
const DISPATCH_SCOUT_TOOL = {
  name: 'dispatch_scout',
  description:
    'Dispatch the coding agent in read-only PLAN MODE to investigate the repo and draft a grounded markdown spec. '
    + 'Use for the FIRST substantive spec work in a session, when you need to know what files exist or how things are currently built. '
    + "The agent reads files and writes prose; it CANNOT edit, commit, or push. Output replaces the session's spec doc. "
    + 'Slow (~30-60s) — do not call for small revisions; use write_spec instead. At most one call per user message.',
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
    },
    required: ['prompt'],
  },
};

// Spec stage — cheap, in-process spec edit. No container, no model
// round-trip beyond the Mayor's own turn. Use this for revisions once a
// spec exists (you wrote it yourself, or scout drafted it). Forbidden
// to combine with dispatch_claude_code in the same turn — the user
// dispatches the build themselves via the "Build from spec" button.
const WRITE_SPEC_TOOL = {
  name: 'write_spec',
  description:
    'Overwrite the current draft spec for this session with the given markdown content. '
    + 'Use for cheap revisions when you already understand the change — adding sections, tightening wording, incorporating user feedback. '
    + 'Cannot read the repo; if you need real file evidence, use dispatch_scout first. '
    + 'Do not call dispatch_claude_code in the same turn as write_spec.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description:
          'The full new contents of the spec doc. This OVERWRITES the existing spec. '
          + 'Markdown formatted; pick sections that fit the task (Goal, Screens, Data Model, Edge Cases, etc.).',
      },
    },
    required: ['content'],
  },
};

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
  const content = typeof toolInput?.content === 'string' ? toolInput.content : '';
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
  const preview = content.length > 400 ? `${content.substring(0, 400)}…` : content;

  await sendStatus(
    `Spec updated (${lineCount} lines).`,
    { specPreview: preview, specLines: lineCount }
  );
  send('spec_updated', { length: charCount, lines: lineCount });

  return {
    toolResultText:
      `The session's spec doc was overwritten with new content (${lineCount} lines, ${charCount} chars). `
      + `It's visible on the user's Spec tab; they can review, hand-edit, and click "Build from spec" when ready.`,
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

Your job is to investigate this repo and produce a MARKDOWN SPEC for the change. The spec should be:
- A complete, self-contained markdown document the user can review on its own.
- Grounded in real file evidence — reference actual file paths and current behaviour, not guesses.
- Structured with sensible headings (e.g. Goal, Affected Screens, Data Model, Edge Cases, Open Questions). Pick whatever sections fit the task; one size does not fit all.
- Specific enough that a coding agent could implement it without re-doing your investigation, but NOT a literal diff or code block.

Your final assistant message must be ONLY the markdown spec — no preamble, no "I'll investigate...", no "Here's the spec:". The host captures that final message verbatim and stores it as the session's spec doc.`;

  // Ensure the long-lived worker is warm before exec'ing run-cc.sh inside
  // it. Cold-start cost (clone + checkout + sleep wrapper) is paid here on
  // the first dispatch of a session; subsequent ensures are sub-second.
  // Bootstrap progress (clone/checkout/warm-ready) flows through onProgress
  // to the dev-chat UI just like the legacy single-shot path used to.
  const containerName = await worker.ensureWorker(session.id, {
    repoOwner,
    repoName,
    branchName: session.branch_name,
    anthropicApiKey: userApiKey || config.anthropicApiKey,
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

    let result;
    try {
      result = await worker.execInWorker(session.id, {
        mode: 'scout',
        prompt: scoutPrompt,
        model: selectedModel,
        commitMsg: '',
        resumeSessionId: session.cc_session_id || null,
        branchName: session.branch_name,
        anthropicApiKey: userApiKey || config.anthropicApiKey,
        onProgress: (text) => {
          send('cc_progress', { text });
          workerProgress.set(session.id, text, { model: selectedModel });
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

    const ccText = (result.lastResultText || '').trim();

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
      const preview = ccText.length > 400 ? `${ccText.substring(0, 400)}…` : ccText;
      await sendStatus(
        `Scout drafted a ${lineCount}-line spec from the codebase.`,
        { specPreview: preview, specLines: lineCount, scoutOutput: ccText }
      );
      send('spec_updated', { length: ccText.length, lines: lineCount });
      summaryParts.push(
        `The scout investigated the repo and drafted a ${lineCount}-line markdown spec. `
        + `It now lives in the session's spec doc; the user should review it on the Spec tab and click "Build from spec" when ready.`
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
  const claudePrompt = `USER REQUEST: "${userMessage}"

CODING TASK (from the Mayor):
${toolPromptArg}

==== PLATFORM CONVENTIONS (authoritative) ====

${getAppConventions()}

==== END PLATFORM CONVENTIONS ====

A \`CLAUDE.md\` at the repo root, if present, contains **app-specific**
guidance: product intent, domain terms, opt-in policies, style. Follow
it for app-specific matters. On any platform-wide rule (auth,
public/private tables, USERNODE_ENV, do-not-push, etc.) the block above
is authoritative and overrides CLAUDE.md if they conflict.

The repo's \`CLAUDE.md\` may reference a hosted copy of the platform
conventions at \`https://${process.env.USERNODE_DOMAIN || 'usernode.evanshapiro.dev'}/claude.md\` —
in dev-chat you already have those rules injected above, so ignore
that instruction here. It's for humans or Claude Code invocations
that run against this repo outside the harness.

INSTRUCTIONS:
- IMPLEMENT the requested changes fully. Do not just explore — write code.
- Spend minimal time reading files. Focus on writing and editing.
- Create or modify all necessary files to complete the request.
- If building something new, implement the full feature — don't stop partway.
- After all changes are made, stage everything with "git add -A" and commit
  with a clear message describing what was built.
- Do NOT ask questions or request clarification. Just build it.`;

  const commitMsg = github.safeMention(`Changes: ${userMessage.substring(0, 50)}`);

  // BYOK (#30): the warm container takes the user's key (if provided)
  // at bootstrap time. On subsequent ensures the container is already
  // warm, so a per-turn key change wouldn't refresh the env — but
  // execInWorker re-asserts ANTHROPIC_API_KEY as a per-exec secret env
  // var, so each turn picks up the active key without needing a re-warm.
  const containerName = await worker.ensureWorker(session.id, {
    repoOwner,
    repoName,
    branchName: session.branch_name,
    anthropicApiKey: userApiKey || config.anthropicApiKey,
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
    await sendStatus('Claude Code is making changes...');

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
        anthropicApiKey: userApiKey || config.anthropicApiKey,
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

    const ccText = result.lastResultText || '';
    commitHash = result.sha;
    const hasChanges = result.ahead > 0 && !!commitHash;

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

      const wasNewPR = !session.pr_number;
      const prResult = await prMetadata.applyPrMetadata({
        pool, session, repoOwner, repoName,
        userMessage, ccSummary: ccText, username: req.user.username,
        broadcast: (event, data) => send(event, data),
        apiKey: userApiKey,
      });
      if (prResult && wasNewPR) {
        await sendStatus(`PR #${prResult.prNumber} created`);
        summaryParts.push(`Opened PR #${prResult.prNumber}: ${prResult.prUrl}`);
      } else if (session.pr_number && !wasNewPR) {
        summaryParts.push(`Pushed to existing PR #${session.pr_number}.`);
      }

      if (result.costUsd) {
        const ccCostCents = Math.round(result.costUsd * 100);
        await pool.query(
          `INSERT INTO llm_usage (user_id, date, total_cost_cents) VALUES ($1, CURRENT_DATE, $2)
           ON CONFLICT (user_id, date) DO UPDATE SET total_cost_cents = llm_usage.total_cost_cents + EXCLUDED.total_cost_cents`,
          [req.user.id, ccCostCents]
        );
        send('usage', { costCents: ccCostCents, model: `claude-code/${selectedModel}` });
      }

      await sendStatus('Building staging preview...');
      const app = { id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url };
      const stagingResult = await staging.buildAndDeployStaging(config, session, app, commitHash);

      await pool.query(
        `UPDATE chat_sessions SET staging_container_id = $1, staging_url = $2 WHERE id = $3`,
        [stagingResult.containerId, stagingResult.stagingUrl, session.id]
      );

      stagingUrl = stagingResult.stagingUrl;
      await sendStatus('Staging deployed!', { stagingUrl });
      send('staging_ready', { url: stagingUrl });
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
            await ok.rest.issues.createComment({
              owner: repoOwner, repo: repoName,
              issue_number: session.pr_number,
              body: github.safeMention(`**Staging deployed!**\n\n${stagingResult.stagingUrl}\n\nCommit: ${commitHash.substring(0, 8)}`),
            });
          }
        } catch (commentErr) {
          log.warn('sessions', 'Failed to comment on PR', { err: commentErr.message });
        }
      }

      log.info('sessions', 'Full dev cycle complete', { sessionId: session.id, commitHash: commitHash.substring(0, 8) });
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

function getMayorSystemPrompt(appName, isWorkerBusy) {
  const toolNote = isWorkerBusy
    ? `\n\nSTATUS: A coding agent IS currently running for this session — the dispatch_claude_code, dispatch_scout, and write_spec tools are NOT available right now. Just chat with the user; tell them the agent is still working and they can follow up once it finishes.`
    : `\n\nSTATUS: No coding agent is running. You MAY use dispatch_claude_code, dispatch_scout, or write_spec when appropriate (see the rules below). Otherwise just reply in text and do not call any tools.`;

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

  return `You are the Mayor — a friendly project manager for the app "${appName}" on Usernode Social Vibecoding.

YOUR ROLE:
You talk to the user in plain English and decide whether their latest message needs the coding agent (Claude Code) to actually edit the repo, OR needs spec-stage planning before any code is written. You are NOT a developer — never write code, file contents, diffs, or implementation details. Keep replies to 1-4 sentences.

THE SPEC DOC:
Every session has a markdown SPEC DOC that the user can see on the Spec tab and edit by hand. It is your collaborative working surface for planning before code is written. The user may have you draft, refine, edit, or replace it — and the user has a "Build from spec" button to dispatch the coding agent for real once they're happy. You don't need to call dispatch_claude_code just because the spec is done; the user owns that decision.

THREE TOOLS, in priority order:

1) dispatch_scout(prompt) — read-only repo investigation, slow (~30-60s)
   Use for the FIRST substantive spec work in a session, when you need to know how the app is currently built. The scout is the coding agent in read-only mode: it reads files (Read/Glob/Grep), writes prose, and is structurally forbidden from editing or committing. Output replaces the session's spec doc.
   Heuristic: if your reply would be "I'd need to look at the code to answer that", that's a dispatch_scout signal — not an excuse to guess.
   Do NOT use for small revisions. It's slow and expensive.

2) write_spec(content) — cheap in-process spec edit, ms-fast
   Use for revisions once a spec exists (you wrote it, scout drafted it, or the user typed it). No repo access — purely a markdown edit. Pass the FULL new spec content; this OVERWRITES the existing doc.
   Cannot fact-check itself against the repo, so don't use it for changes where you need to confirm what the code currently does — use dispatch_scout for that.

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
- Never call write_spec and dispatch_claude_code in the same turn. The user dispatches the build themselves.

AFTER A TOOL RETURNS:
You'll get a short summary of what happened. Write a 1-3 sentence reply to the user in plain English, referencing the spec doc / staging URL / PR if present. For dispatch_scout: tell them the spec was drafted and is on the Spec tab for review. For write_spec: tell them what you changed in the spec. For dispatch_claude_code: summarize what was built. If anything failed, explain briefly and suggest next steps.

HISTORY CONTEXT:
Some assistant turns in this conversation contain "[CODING AGENT COMPLETED]:" — that is a summary from a PAST coding-agent run, written by the system, not by you. You may reference it when the user asks an INFORMATIONAL question about a past turn (e.g. "what did you do?", "why did you change X?", "what files were touched?") — quote or paraphrase to answer.

You MUST NOT, under any circumstances:
- Write the literal string "[CODING AGENT COMPLETED]" in your reply. That marker is reserved for the harness; emitting it yourself fakes a coding-agent run that never happened.
- Paraphrase a past summary as a substitute for dispatching a new run. If the user reports a bug, regression, or "still not quite right" — even if a previous run targeted the same area — that is a NEW change request and you MUST call dispatch_claude_code (assuming the tool is available per STATUS). Past summaries are read-only history; they cannot fix new bugs.${toolNote}${conventionsBlock}`;
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

  // Clone DB
  const prodDbName = dbManager.appDbName(app.slug);
  const stagingDbName = dbManager.stagingDbName(app.slug, `s${session.id}`, hash);
  await dbManager.cloneDatabase(prodDbName, stagingDbName);
  const stagingDbUrl = await dbManager.connectionUrl(stagingDbName);

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
  const hostname = caddy.stagingHostname(app.slug, `s${session.id}`, hash);

  await caddy.registerRoute(hostname, containerName, 3000).catch(() => {});

  const stagingUrl = hostPort
    ? `http://localhost:${hostPort}`
    : `https://${hostname}`;

  return { containerId, stagingUrl, hostname };
}

module.exports = { sessionRoutes, getActiveWorkerCount };
