'use strict';

const log = require('./logger');
const llm = require('./llm');
const github = require('./github');

// Generate a PR title + body from the user's latest message and
// Claude Code's own summary of what it built. Shared by:
//  - the normal dev-turn path in routes/sessions.js (SSE-backed)
//  - the orphan-recovery path in server.js (runs after a mid-flight
//    nodemon/server restart adopts an in-progress worker)
//
// Returns `{ title, body, usage?, model? }`. Never throws — falls back
// to the legacy template so PR creation is never blocked on LLM
// availability. `usage` is undefined when the fallback fires (no API
// call was made) so callers can skip debiting in that case.
async function generatePrMetadata({ userMessage, ccSummary, requests, summaries, specs, username, apiKey }) {
  const fallbackTitle = `${username}'s changes`;
  const fallbackBody = `Dev session by ${username} via Usernode`;

  // When the caller passes a user's own key (BYOK, #30) we can hit the
  // Anthropic API even if the server has no admin key configured, so
  // check isEnabled only as a fallback guard.
  if (!apiKey && !llm.isEnabled()) {
    return { title: fallbackTitle, body: fallbackBody };
  }

  try {
    const meta = await llm.generatePrMetadata({
      userRequest: userMessage,
      ccSummary,
      requests,
      summaries,
      specs,
      username,
      apiKey,
    });
    return {
      title: meta.title,
      body: `${meta.body}\n\n---\n_Dev session by ${username} via Usernode_`,
      usage: meta.usage,
      model: meta.model,
    };
  } catch (err) {
    log.warn('pr-metadata', 'Generation failed; using fallback', { err: err.message });
    return { title: fallbackTitle, body: fallbackBody };
  }
}

// Pull the full per-turn history for a session so the PR title/body can
// reflect every update on the branch, not just the latest turn (#26):
//  - `requests`:  every user-role message, chronological. The current
//                 turn's message is already persisted (sessions.js inserts
//                 it before the worker runs), so it's included here.
//  - `summaries`: each completed turn's coding-agent summary, persisted as
//                 a system row with metadata.ccOutput. The CURRENT turn's
//                 summary is NOT yet persisted when this runs, so callers
//                 pass it separately and we append it as the final entry.
//  - `specs`:     the session's spec doc(s) — the Mayor-maintained markdown
//                 that captures overall intent. Includes the live draft
//                 (chat_sessions.spec_md) plus any saved snapshots
//                 (chat_session_specs), since a single chat can carry more
//                 than one distinct spec (#27). Deduped, oldest-first.
//                 Used as a THEME signal: it describes intended scope (which
//                 may run ahead of what's actually built), so the prompt
//                 leans on requests/summaries for the concrete changes.
async function gatherSessionContext(pool, sessionId, currentCcSummary) {
  const ctx = { requests: [], summaries: [], specs: [] };
  if (pool && sessionId != null) {
    try {
      const { rows } = await pool.query(
        `SELECT role, content, metadata FROM chat_session_messages
           WHERE session_id = $1
             AND (role = 'user' OR (role = 'system' AND metadata->>'ccOutput' IS NOT NULL))
           ORDER BY id ASC`,
        [sessionId]
      );
      for (const row of rows) {
        if (row.role === 'user' && row.content) {
          ctx.requests.push(row.content);
        } else if (row.role === 'system' && row.metadata && row.metadata.ccOutput) {
          ctx.summaries.push(String(row.metadata.ccOutput));
        }
      }
    } catch (err) {
      log.warn('pr-metadata', 'Failed to gather session history; using current turn only', { err: err.message, sessionId });
    }

    // Spec(s): saved snapshots (oldest-first) then the live draft. We dedupe
    // exact duplicates so an unchanged draft that was also "saved" doesn't
    // appear twice. Querying by session.id keeps both call sites (sessions.js
    // and the server.js orphan path) working without passing spec text in.
    try {
      const specTexts = [];
      const { rows: specRows } = await pool.query(
        `SELECT content FROM chat_session_specs WHERE session_id = $1 ORDER BY version ASC`,
        [sessionId]
      );
      for (const r of specRows) {
        const c = (r.content || '').trim();
        if (c) specTexts.push(c);
      }
      const { rows: liveRows } = await pool.query(
        `SELECT spec_md FROM chat_sessions WHERE id = $1`,
        [sessionId]
      );
      const live = (liveRows[0] && liveRows[0].spec_md ? String(liveRows[0].spec_md) : '').trim();
      if (live) specTexts.push(live);

      const seen = new Set();
      for (const s of specTexts) {
        if (!seen.has(s)) { seen.add(s); ctx.specs.push(s); }
      }
    } catch (err) {
      log.warn('pr-metadata', 'Failed to gather session specs', { err: err.message, sessionId });
    }
  }
  // Append the in-flight turn's summary (not yet persisted). Skip if it's
  // already the last entry (e.g. orphan-recovery may re-read a row).
  const cur = (currentCcSummary || '').trim();
  if (cur && ctx.summaries[ctx.summaries.length - 1] !== cur) {
    ctx.summaries.push(cur);
  }
  return ctx;
}

// Either open a new PR with the generated title/body, or update the
// existing PR's title/body on GitHub when it changed. Persists to DB
// and fires a broadcast callback so connected clients update in real
// time. Returns the resulting { prNumber, prUrl, prTitle } (or null
// if PR operations aren't possible: no repo, no github app, etc.).
//
// `userId` is the user the platform-side Haiku call is debited to.
// Both call sites already know it (sessions.js: req.user.id; server.js
// orphan recovery: session.user_id). When the fallback template fires
// (no API call) or BYOK is used, no debit happens.
async function applyPrMetadata({
  pool, session, repoOwner, repoName,
  userMessage, ccSummary, username,
  broadcast, apiKey, userId,
}) {
  if (!repoOwner || !repoName) return null;

  // Build cumulative context across all of this PR's turns. Falls back to
  // the single current turn when no history is available.
  const { requests, summaries, specs } = await gatherSessionContext(pool, session && session.id, ccSummary);

  const meta = await generatePrMetadata({
    userMessage, ccSummary, requests, summaries, specs, username, apiKey,
  });
  const { title: prTitle, body: prBody } = meta;

  // Debit the platform Haiku call to the session owner. Skip when
  // BYOK is in effect (user's own key paid for it) or the fallback
  // template fired (no API call was made).
  if (!apiKey && meta.usage && userId != null && pool) {
    try {
      const costCents = llm.estimateCostCents(meta.usage, meta.model);
      await pool.query(
        `INSERT INTO llm_usage (user_id, date, total_cost_cents) VALUES ($1, CURRENT_DATE, $2)
         ON CONFLICT (user_id, date) DO UPDATE SET total_cost_cents = llm_usage.total_cost_cents + EXCLUDED.total_cost_cents`,
        [userId, costCents]
      );
    } catch (err) {
      log.warn('pr-metadata', 'Failed to record llm_usage', { err: err.message, userId });
    }
  }

  if (!session.pr_number) {
    // New PR path.
    try {
      const pr = await github.createPR(repoOwner, repoName, {
        branch: session.branch_name,
        title: prTitle,
        body: prBody,
      });
      session.pr_number = pr.number;
      session.pr_url = pr.html_url;
      session.pr_title = prTitle;
      await pool.query(
        `UPDATE chat_sessions SET pr_number = $1, pr_url = $2, pr_title = $3 WHERE id = $4`,
        [pr.number, pr.html_url, prTitle, session.id]
      );
      if (broadcast) broadcast('pr_created', { prNumber: pr.number, prUrl: pr.html_url, prTitle });
      return { prNumber: pr.number, prUrl: pr.html_url, prTitle };
    } catch (err) {
      log.warn('pr-metadata', 'PR creation failed', { err: err.message, sessionId: session.id });
      return null;
    }
  }

  // Existing PR: only hit GitHub if the title actually changed.
  if (prTitle === session.pr_title) {
    return { prNumber: session.pr_number, prUrl: session.pr_url, prTitle: session.pr_title };
  }

  try {
    await github.updatePR(repoOwner, repoName, session.pr_number, {
      title: prTitle,
      body: prBody,
    });
    session.pr_title = prTitle;
    await pool.query(
      `UPDATE chat_sessions SET pr_title = $1 WHERE id = $2`,
      [prTitle, session.id]
    );
    if (broadcast) broadcast('pr_updated', { prNumber: session.pr_number, prUrl: session.pr_url, prTitle });
    return { prNumber: session.pr_number, prUrl: session.pr_url, prTitle };
  } catch (err) {
    log.warn('pr-metadata', 'PR title update failed', { err: err.message, sessionId: session.id });
    return null;
  }
}

module.exports = { generatePrMetadata, applyPrMetadata };
