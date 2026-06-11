'use strict';

// #155: headless "auto sessions" — the issue panel's Auto-solve button.
//
// A headless session is a normal chat_sessions row (owned and billed to
// the user who clicked the button) whose build turn is dispatched by the
// platform itself instead of an interactive dev chat: we seed the prompt
// from the GitHub issue and run the EXACT same Claude Code build pipeline
// the Mayor's dispatch_claude_code uses (routes/sessions.js
// runClaudeCodeTool — commit, push, PR with `Closes #N`, staging deploy),
// just with no SSE response attached. Progress still flows onto the
// session bus + global WS and into chat_session_messages, so opening the
// session in dev chat later shows the full timeline.
//
// State machine (chat_sessions.headless_state): 'running' → 'done' |
// 'failed'. The Open Issues panel polls GET /api/apps/:slug/auto-sessions
// and renders "Generating auto session…" while running.

const log = require('./logger');
const github = require('./github');
const limits = require('./limits');
const events = require('./events');
const sessionBus = require('./session-bus');
const sessionLifecycle = require('./session-lifecycle');
const secrets = require('./secrets');

// How long a 'running' auto session may sit before the lazy sweep in
// listAutoSessions marks it failed. Covers the platform restarting (or
// crashing) mid-run, which orphans the in-process background promise —
// without this the issue row would show "Generating…" forever.
const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;

// Event types that the chat handler keeps off the global WS (they're
// only meaningful on a live SSE stream). Mirrored here so headless runs
// broadcast the same envelope shape as interactive turns.
const SSE_ONLY = new Set(['token', 'usage', 'error', 'mayor_reasoning']);

// Build the seed prompt pair for the issue. `userMessage` mirrors the
// seed the "Create PR" button types into a dev chat (so the recorded
// transcript reads the same), and `toolPromptArg` is what the Mayor
// would have passed to dispatch_claude_code.
function buildIssuePrompts(issueNumber, issueTitle, issueBody) {
  const title = issueTitle || '';
  const body = issueBody ? `\n\n${issueBody}` : '';
  const userMessage =
    `Please implement GitHub issue #${issueNumber}: "${title}".${body}\n\n`
    + `Open a PR that closes this issue (include "Closes #${issueNumber}" so it links and closes the issue on merge).`;
  const toolPromptArg =
    `Implement GitHub issue #${issueNumber} ("${title}") fully. This is an automated headless session `
    + `dispatched directly from the issue — there is no human in the loop, so implement the complete change `
    + `the issue describes, make sensible decisions where it is ambiguous, and commit when done.`;
  return { userMessage, toolPromptArg };
}

// Start a headless auto session for a GitHub issue. Validates caps +
// budget, creates the branch + session row synchronously (so the caller
// can 201 with the session), then runs the build pipeline in the
// background. Throws { status, message } style errors via the returned
// { error, status } shape — the route translates them to HTTP.
async function startHeadlessIssueSession({
  config, pool, user, app, issueNumber, issueTitle, issueBody, model,
}) {
  // One running auto session per issue per app — a second click while
  // one is generating would just race the same branch-less work.
  const { rows: dupRows } = await pool.query(
    `SELECT id FROM chat_sessions
     WHERE app_id = $1 AND headless AND headless_issue_number = $2 AND headless_state = 'running'`,
    [app.id, issueNumber]
  );
  if (dupRows.length) {
    return { error: 'An auto session is already running for this issue.', status: 409 };
  }

  // Same per-user / global caps as POST /api/apps/:slug/sessions —
  // headless sessions consume the same worker + staging resources.
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM chat_sessions WHERE user_id = $1 AND status IN ('active', 'promoted')`,
    [user.id]
  );
  if (parseInt(countRows[0].cnt) >= config.maxUserSessions) {
    return { error: `You already have ${config.maxUserSessions} active sessions. Pause, archive, or merge one first.`, status: 429 };
  }
  const { rows: globalRows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM chat_sessions WHERE status IN ('active', 'promoted')`
  );
  if (parseInt(globalRows[0].cnt) >= config.maxGlobalSessions) {
    const { freed } = await sessionLifecycle.freeGlobalSlot({
      pool, graceMs: config.sessionPressureGraceMs,
    });
    if (!freed) {
      return { error: 'Platform is at capacity right now. Try again in a few minutes.', status: 429 };
    }
  }

  // BYOK (#30): same resolution as the chat handler. With a personal
  // key the run bills Anthropic directly and skips the shared budget
  // gate; without one, the clicking user's daily budget is checked up
  // front and debited as the run progresses.
  let userApiKey = null;
  try {
    const { rows: keyRows } = await pool.query(
      'SELECT anthropic_key_enc FROM users WHERE id = $1',
      [user.id]
    );
    if (keyRows[0]?.anthropic_key_enc) {
      userApiKey = secrets.decrypt(keyRows[0].anthropic_key_enc, config.jwtSecret);
    }
  } catch (err) {
    log.warn('headless', 'Failed to load user API key', { userId: user.id, err: err.message });
  }
  if (!userApiKey) {
    const budgetCheck = await limits.checkBudget(pool, user.id);
    if (budgetCheck.error) return { error: budgetCheck.error, status: 429 };
  }

  const [, repoOwner, repoName] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!repoOwner || !repoName) {
    return { error: 'No GitHub repo configured for this app', status: 400 };
  }

  const branchName = `dev/${user.username}-auto-${Date.now()}`;
  if (github.isEnabled()) {
    try {
      await github.createBranch(repoOwner, repoName, branchName);
    } catch (err) {
      log.warn('headless', 'GitHub branch creation failed (continuing)', { err: err.message });
    }
  }

  // linked_issues seeds the deterministic `Closes #N` block in the PR
  // body (services/pr-metadata.js) — that linkage is what auto-closes
  // the issue on merge and drives bounty payouts.
  const { rows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, status, headless, headless_issue_number, headless_state, linked_issues)
     VALUES ($1, $2, $3, 'active', TRUE, $4, 'running', $5)
     RETURNING *`,
    [app.id, user.id, branchName, issueNumber, [issueNumber]]
  );
  const session = rows[0];
  // The build pipeline reads app fields off the session row (the chat
  // handler gets them from its JOIN) — attach them the same way.
  session.app_slug = app.slug;
  session.app_name = app.name;
  session.repo_url = app.repo_url;

  const { userMessage } = buildIssuePrompts(issueNumber, issueTitle, issueBody);
  await pool.query(
    `INSERT INTO chat_session_messages (session_id, role, content) VALUES ($1, 'user', $2)`,
    [session.id, userMessage]
  );

  log.info('headless', 'Auto session created', {
    sessionId: session.id, appId: app.id, issueNumber, userId: user.id, model,
  });
  events.record(pool, {
    type: events.EVENT_TYPES.DEV_SESSION_STARTED,
    userId: user.id,
    appId: app.id,
    sessionId: session.id,
    metadata: { headless: true, issueNumber },
  });

  // Fire-and-forget: the HTTP response returns now; the issue panel
  // tracks completion by polling GET /api/apps/:slug/auto-sessions.
  runHeadlessBuild({
    config, pool, user, session, repoOwner, repoName,
    issueNumber, issueTitle, issueBody, model, userApiKey,
  }).catch(async (err) => {
    log.error('headless', 'Auto session crashed', { sessionId: session.id, err: err.message, stack: err.stack });
    await markState(pool, session.id, 'failed', err.message).catch(() => {});
  });

  return { session };
}

async function markState(pool, sessionId, state, error) {
  await pool.query(
    `UPDATE chat_sessions SET headless_state = $1, headless_error = $2 WHERE id = $3`,
    [state, error ? String(error).slice(0, 500) : null, sessionId]
  );
}

// The background half: drives routes/sessions.js runClaudeCodeTool with
// no live HTTP response. Events go to the session bus + global WS (same
// envelope as interactive turns) and statuses persist as system messages,
// so the session's timeline is complete if anyone opens it in dev chat.
async function runHeadlessBuild({
  config, pool, user, session, repoOwner, repoName,
  issueNumber, issueTitle, issueBody, model, userApiKey,
}) {
  // Lazy require to avoid a module-load cycle (routes/sessions.js is a
  // heavyweight module; this service is loaded by routes/issues.js).
  const { runClaudeCodeTool } = require('../routes/sessions');
  const { broadcastGlobal } = require('./ws');

  const seqPrefix = Date.now().toString(36);
  let eventSeq = 0;
  const send = (type, data) => {
    const event = { type, _seq: `${seqPrefix}-${++eventSeq}`, ...data };
    if (!SSE_ONLY.has(type)) {
      broadcastGlobal({ type: 'session_event', sessionId: session.id, event: type, ...event });
    }
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

  // No POST /stop wiring for headless runs (nothing registers in the
  // chat handler's stopRegistry) — archive/pause the session to kill it.
  const stopHandle = {
    abort: new AbortController(),
    workerName: null,
    execChild: null,
    phase: 'cc',
    stopped: false,
    stoppedBy: null,
  };

  const { userMessage, toolPromptArg } = buildIssuePrompts(issueNumber, issueTitle, issueBody);

  await sendStatus(`Auto session started for issue #${issueNumber} — running headless (no dev chat attached).`);

  try {
    const result = await runClaudeCodeTool({
      pool,
      config,
      // runClaudeCodeTool only reads req.user.{id, username}: id for
      // llm_usage debits (the clicking user pays) and username for PR
      // metadata attribution.
      req: { user: { id: user.id, username: user.username } },
      // Only used for SSE heartbeats — a sink is fine.
      res: { write() {} },
      session,
      selectedModel: model,
      userMessage,
      toolPromptArg,
      repoOwner,
      repoName,
      send,
      sendStatus,
      stopHandle,
      userApiKey,
    });

    if (result.isError) {
      await markState(pool, session.id, 'failed', result.toolResultText);
      await sendStatus(`Auto session for issue #${issueNumber} did not complete successfully.`);
    } else {
      await markState(pool, session.id, 'done', null);
      const prNote = session.pr_number ? ` PR #${session.pr_number} is up for review.` : '';
      await sendStatus(`Auto session for issue #${issueNumber} finished.${prNote}`);
    }
    log.info('headless', 'Auto session finished', {
      sessionId: session.id, issueNumber, isError: !!result.isError, prNumber: session.pr_number || null,
    });
  } catch (err) {
    await markState(pool, session.id, 'failed', err.message);
    await sendStatus(`Auto session error: ${String(err.message || err).slice(0, 200)}`);
    throw err;
  } finally {
    send('done', {});
    setTimeout(() => sessionBus.clearSession(session.id), 30000);
  }
}

// Latest auto session per issue number for an app, keyed by issue
// number — the Open Issues panel merges this into its rows. Includes a
// lazy staleness sweep so a platform restart mid-run can't leave an
// issue stuck on "Generating…" forever.
async function listAutoSessions(pool, appId) {
  await pool.query(
    `UPDATE chat_sessions SET headless_state = 'failed',
            headless_error = 'Auto session timed out (platform restarted or run exceeded the time limit).'
     WHERE app_id = $1 AND headless AND headless_state = 'running'
       AND created_at < NOW() - ($2 || ' milliseconds')::interval`,
    [appId, String(STALE_RUNNING_MS)]
  ).catch(() => {});

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (headless_issue_number)
            id, headless_issue_number, headless_state, headless_error,
            pr_number, pr_url, status, user_id, created_at
     FROM chat_sessions
     WHERE app_id = $1 AND headless AND headless_issue_number IS NOT NULL
     ORDER BY headless_issue_number, created_at DESC`,
    [appId]
  );

  const byIssue = {};
  for (const r of rows) {
    byIssue[r.headless_issue_number] = {
      sessionId: r.id,
      state: r.headless_state,
      error: r.headless_error || null,
      prNumber: r.pr_number || null,
      prUrl: r.pr_url || null,
      sessionStatus: r.status,
      createdAt: r.created_at,
    };
  }
  return byIssue;
}

module.exports = { startHeadlessIssueSession, listAutoSessions };
