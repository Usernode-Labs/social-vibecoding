'use strict';

// #297: the per-proposal "Ask AI" advisor — a private, per-user,
// read-only multi-turn LLM conversation scoped to ONE proposal. It is
// "the Mayor in advisor mode": it reuses the platform's direct-Anthropic
// chat path (llm.streamChat), the same per-user billing (limits), the
// same model allowlist (models), and the same contextualization approach
// as the Mayor turn in routes/sessions.js — but with the entire
// tool/dispatch/worker machinery removed. streamChat is called with NO
// `tools`, so the advisor can only emit text: the read-only boundary is
// structural, not just prose.
//
// Routes (both keyed by ?kind=pr|gov so the polymorphic proposal_ref is
// unambiguous):
//   POST /api/apps/:slug/proposals/:id/discuss   — one chat turn, SSE
//   GET  /api/apps/:slug/proposals/:id/discuss   — persisted history

const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const llm = require('../services/llm');
const github = require('../services/github');
const limits = require('../services/limits');
const models = require('../services/models');
const prompts = require('../services/prompts');
const appAccess = require('../services/app-access');
const { proposalDiscussLimiter } = require('../middleware/rate-limits');

// Resolve the app (collab access) plus the columns the advisor prompt
// needs (name, repo_url). 404 on deny so private apps aren't enumerable.
async function loadApp(pool, req) {
  return appAccess.getAppForUser(
    pool, req.params.slug, req.user, 'collab',
    `${appAccess.ACCESS_COLUMNS}, name, repo_url`
  );
}

// Load the proposal addressed by (:id, ?kind). Returns a normalized shape
// the prompt builder understands, or null if it doesn't exist / isn't a
// discussable proposal in this app.
async function loadProposal(pool, app, id, kind) {
  if (kind === 'gov') {
    const { rows } = await pool.query(
      `SELECT i.id, i.kind, i.title, i.description, i.payload, i.github_issue_number,
              i.status, u.username AS author
         FROM issues i
         LEFT JOIN users u ON i.created_by = u.id
        WHERE i.id = $1 AND i.app_id = $2`,
      [id, app.id]
    );
    if (!rows.length) return null;
    const r = rows[0];
    // Never let the secret ciphertext reach the model — mirror the strip
    // in routes/issues.js (valueEnc removed; only key/action survive).
    let govPayload = r.payload || {};
    if (r.kind === 'secret_change' && govPayload) {
      const { valueEnc, ...rest } = govPayload;
      govPayload = rest;
    }
    return {
      kind: 'gov',
      ref: r.id,
      title: r.title,
      author: r.author,
      status: r.status,
      specMd: r.description || '',
      govKind: r.kind,
      govPayload,
    };
  }

  // PR proposal (promoted / merging / merged chat session).
  const { rows } = await pool.query(
    `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.spec_md, cs.branch_name,
            cs.linked_issues, cs.status, u.username AS author,
            (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') AS yes_count,
            (SELECT COUNT(*)::int FROM pr_votes WHERE session_id = cs.id AND vote = 'no')  AS no_count
       FROM chat_sessions cs
       LEFT JOIN users u ON cs.user_id = u.id
      WHERE cs.id = $1 AND cs.app_id = $2
        AND cs.status IN ('promoted', 'merging', 'merged')`,
    [id, app.id]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    kind: 'pr',
    ref: r.id,
    title: r.pr_title,
    author: r.author,
    status: r.status,
    prNumber: r.pr_number,
    prUrl: r.pr_url,
    branchName: r.branch_name,
    specMd: r.spec_md || '',
    linkedIssues: Array.isArray(r.linked_issues) ? r.linked_issues : [],
    voteTally: { yes: r.yes_count, no: r.no_count },
  };
}

// Best-effort GitHub enrichment for PR proposals — the PR body and a
// size-capped diff. BOTH fail open: a GitHub hiccup degrades the
// conversation to metadata + spec, it never breaks it (mirrors the
// Mayor's issue-seed degradation).
async function loadGithubContext(app, proposal) {
  let prBody = '';
  let diff = '';
  if (proposal.kind !== 'pr' || !github.isEnabled() || !app.repo_url) {
    return { prBody, diff };
  }
  const [, owner, repo] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  if (!owner || !repo) return { prBody, diff };

  if (proposal.prNumber) {
    try {
      const pr = await github.getPR(owner, repo, proposal.prNumber);
      prBody = pr?.body || '';
    } catch (err) {
      log.warn('proposal-discuss', 'PR body fetch failed (continuing)', { prNumber: proposal.prNumber, err: err.message });
    }
  }
  if (proposal.branchName) {
    try {
      const res = await github.getProposalDiff(owner, repo, `main...${proposal.branchName}`);
      diff = res.diff || '';
    } catch (err) {
      log.warn('proposal-discuss', 'Diff fetch failed (continuing)', { branch: proposal.branchName, err: err.message });
    }
  }
  return { prBody, diff };
}

async function loadHistory(pool, app, proposal, userId) {
  const { rows } = await pool.query(
    `SELECT role, content, model, created_at
       FROM proposal_ai_messages
      WHERE app_id = $1 AND proposal_kind = $2 AND proposal_ref = $3 AND user_id = $4
      ORDER BY id ASC`,
    [app.id, proposal.kind, proposal.ref, userId]
  );
  return rows;
}

function proposalDiscussRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Return the persisted per-user history when the panel opens.
  router.get('/api/apps/:slug/proposals/:id/discuss', async (req, res) => {
    try {
      const app = await loadApp(pool, req);
      if (!app) return res.status(404).json({ error: 'App not found' });

      const kind = req.query.kind === 'gov' ? 'gov' : 'pr';
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad proposal id' });

      const proposal = await loadProposal(pool, app, id, kind);
      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

      const history = await loadHistory(pool, app, proposal, req.user.id);
      res.json({
        messages: history.map((m) => ({
          role: m.role, content: m.content, model: m.model, created_at: m.created_at,
        })),
        proposal: { title: proposal.title, author: proposal.author, status: proposal.status },
      });
    } catch (err) {
      log.error('proposal-discuss', 'history load failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // One advisor turn, streamed over SSE. No tools, no worker, no phases —
  // a subset of the Mayor turn's event vocabulary: token, usage, error, done.
  router.post('/api/apps/:slug/proposals/:id/discuss', proposalDiscussLimiter, async (req, res) => {
    const { message, model } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'Message required' });
    }

    try {
      const app = await loadApp(pool, req);
      if (!app) return res.status(404).json({ error: 'App not found' });

      const kind = req.query.kind === 'gov' ? 'gov' : 'pr';
      const id = parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad proposal id' });

      const proposal = await loadProposal(pool, app, id, kind);
      if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

      // Who pays for this turn (limit-first, BYOK spillover) — same path
      // the Mayor turn uses. A bare 429 when budget is gone and no key.
      const billing = await limits.resolveBillingPath(pool, config.jwtSecret, req.user.id);
      if (billing.error) return res.status(429).json({ error: billing.error });
      const userApiKey = billing.apiKey;

      // Feature gate: no platform key AND no usable user key → disabled,
      // same posture the dev chat takes (and the FE renders the button
      // disabled in this case).
      if (!llm.isEnabled() && !userApiKey) {
        return res.status(503).json({ error: 'LLM not configured' });
      }

      const selectedModel = models.resolve(model);

      // Persist the user's turn before we stream the reply.
      await pool.query(
        `INSERT INTO proposal_ai_messages (app_id, proposal_kind, proposal_ref, user_id, role, content)
         VALUES ($1, $2, $3, $4, 'user', $5)`,
        [app.id, proposal.kind, proposal.ref, req.user.id, String(message).trim()]
      );

      // Build the full multi-turn message array from persisted history
      // (now including the row just inserted) — this is what makes it a
      // real back-and-forth rather than a one-shot call.
      const history = await loadHistory(pool, app, proposal, req.user.id);
      const messages = history
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));

      const { prBody, diff } = await loadGithubContext(app, proposal);
      const systemPrompt = prompts.buildProposalDiscussSystemPrompt({
        appName: app.name || app.slug,
        repoUrl: app.repo_url,
        proposal,
        specMd: proposal.specMd,
        prBody,
        diff,
        voteTally: proposal.voteTally,
        linkedIssues: proposal.linkedIssues,
      });

      // SSE response.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const seqPrefix = Date.now().toString(36);
      let eventSeq = 0;
      const send = (type, data) => {
        const event = { type, _seq: `${seqPrefix}-${++eventSeq}`, ...data };
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch {}
      };

      let result;
      try {
        result = await llm.streamChat({
          messages,
          systemPrompt,
          model: selectedModel,
          // NO tools — the advisor can only talk. This is the structural
          // read-only guarantee.
          onToken: (text) => send('token', { text }),
          apiKey: userApiKey,
        });
      } catch (err) {
        log.error('proposal-discuss', 'streamChat failed', { message: err.message });
        send('error', { error: 'The AI request failed. Please try again.' });
        send('done', {});
        return res.end();
      }

      const reply = (result.text || '').trim();
      if (reply) {
        await pool.query(
          `INSERT INTO proposal_ai_messages (app_id, proposal_kind, proposal_ref, user_id, role, content, model)
           VALUES ($1, $2, $3, $4, 'assistant', $5, $6)`,
          [app.id, proposal.kind, proposal.ref, req.user.id, reply, selectedModel]
        );
      }

      // Settle cost into the same llm_usage ledger /api/budget reads.
      if (result.usage) {
        const costCents = llm.estimateCostCents(result.usage, selectedModel);
        await limits.recordSpend(pool, req.user.id, costCents, { byok: !!userApiKey });
        send('usage', { costCents, model: selectedModel, byok: !!userApiKey });
      }

      send('done', {});
      res.end();
    } catch (err) {
      log.error('proposal-discuss', 'discuss turn failed', { message: err.message });
      // If headers already went out this is a streamed error; otherwise JSON.
      if (res.headersSent) {
        try { res.write(`data: ${JSON.stringify({ type: 'error', error: 'Internal server error' })}\n\n`); } catch {}
        res.end();
      } else {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  return router;
}

module.exports = { proposalDiscussRoutes };
