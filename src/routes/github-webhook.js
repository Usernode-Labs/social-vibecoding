'use strict';

const { Router } = require('express');
const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const log = require('../services/logger');

// POST /api/github/webhook — GitHub tells us a pull request moved (#2737).
//
// WHY THIS EXISTS. An imported proposal's head is advanced by a poller: a
// sweep re-reads every live imported PR and applies a head change it finds.
// That sweep costs one GitHub read per open proposal, so it is deliberately
// slow — a per-session cooldown of three minutes, at most ten sessions a
// pass. The cost is latency exactly when it is most visible: a push lands,
// and the proposal shows the old commit and the old checks until the sweep
// comes round. One measured case took seven minutes.
//
// A webhook removes the wait without removing the safety net. This route
// does not advance anything itself: it finds the proposal the event is
// about and calls the SAME `syncImportedProposal` the sweep calls, which
// re-reads the PR from GitHub and decides what the move cost the approvals.
// So there is exactly one implementation of "a head moved", and the sweep
// still heals anything a delivery misses.
//
// MOUNTED BEFORE THE JSON PARSER, and before authMiddleware. The signature
// is over the RAW bytes, so a parsed-and-restringified body would not
// verify; and the caller is GitHub, which has no session cookie.
//
// SECURITY. Deny by default: with no secret configured the route is off and
// answers 503, rather than accepting unsigned calls. Every request must
// carry a `sha256=` HMAC of the exact body under that secret, compared with
// a timing-safe equality. Nothing in the payload is trusted beyond the
// repository and the PR number, which are used only to LOOK UP a row we
// already own — the head SHA the sync applies comes from our own
// authenticated read of the API, never from the delivery.

// GitHub's own cap is 25 MB. Ours is far below that: the events we handle
// carry a pull request and a repository, and a body larger than this is
// either not ours or not something we should be buffering.
const MAX_BODY_BYTES = 1024 * 1024;

// The events worth waking for. `synchronize` is the push we were waiting
// on; `opened` covers a PR that appears while its proposal already exists;
// `closed` lets a merge or a close settle immediately rather than at the
// next sweep.
const HANDLED_ACTIONS = new Set(['opened', 'synchronize', 'closed', 'reopened']);

/** Timing-safe `sha256=<hex>` comparison over the raw body. */
function signatureMatches(secret, rawBody, header) {
  if (!secret || !header || !Buffer.isBuffer(rawBody)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // one bit; compare lengths first and always run the same comparison.
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** `https://github.com/owner/repo(.git)` → `owner/repo`, lowercased. */
function repoKey(url) {
  const [, owner, repo] = (String(url || '').match(/github\.com\/([^/]+)\/([^/.]+)/) || []);
  return owner && repo ? `${owner}/${repo}`.toLowerCase() : null;
}

/**
 * The live imported proposals this event could be about.
 *
 * Matched on the PR number and the app's repository, never on the delivery
 * alone: two apps can carry the same PR number, and the row is what decides
 * whether there is anything to do.
 */
async function findProposals(pool, { fullName, prNumber }) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url
       FROM chat_sessions cs
       JOIN apps a ON a.id = cs.app_id
      WHERE cs.source = 'imported'
        AND cs.pr_number = $1
        AND cs.status IN ('active', 'promoted', 'merging')
      ORDER BY cs.id DESC
      LIMIT 10`,
    [prNumber],
  );
  const wanted = String(fullName || '').toLowerCase();
  return rows.filter((row) => repoKey(row.repo_url) === wanted);
}

function githubWebhookRoutes(config, deps = {}) {
  const router = Router();
  const pool = deps.pool || getPool(config);
  const prImportSync = deps.prImportSync || require('../services/pr-import-sync');
  const secret = config.githubWebhookSecret || '';

  // `express.raw` with a wildcard type: GitHub sends application/json, but a
  // form-encoded delivery is a configuration mistake we want to reject on
  // the signature rather than on a parser error.
  const rawBody = express.raw({ type: () => true, limit: MAX_BODY_BYTES });

  router.post('/api/github/webhook', rawBody, async (req, res) => {
    if (!secret) {
      // Configured off. Say so plainly: a 404 would look like a bad URL and
      // send somebody hunting for a routing bug that does not exist.
      return res.status(503).json({ error: 'GitHub webhook is not configured' });
    }
    if (!signatureMatches(secret, req.body, req.get('x-hub-signature-256'))) {
      log.warn('github-webhook', 'Rejected a delivery with a bad or missing signature', {
        event: req.get('x-github-event') || null,
        delivery: req.get('x-github-delivery') || null,
      });
      return res.status(401).json({ error: 'Bad signature' });
    }

    const event = req.get('x-github-event') || '';
    if (event === 'ping') return res.json({ ok: true, pong: true });
    if (event !== 'pull_request') return res.json({ ok: true, ignored: event || 'unknown' });

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Body is not JSON' });
    }

    const action = String(payload?.action || '');
    const prNumber = Number(payload?.pull_request?.number);
    const fullName = payload?.repository?.full_name || '';
    if (!HANDLED_ACTIONS.has(action) || !Number.isInteger(prNumber) || prNumber <= 0) {
      return res.json({ ok: true, ignored: action || 'no action' });
    }

    // Answer GitHub BEFORE doing the work. A sync re-reads the PR and can
    // start a staging build, which is minutes; holding the delivery open
    // that long earns a timeout and a redelivery of work already running.
    res.json({ ok: true, action, prNumber });

    try {
      const proposals = await findProposals(pool, { fullName, prNumber });
      if (!proposals.length) {
        log.info('github-webhook', 'No live proposal for this pull request', { fullName, prNumber, action });
        return;
      }
      for (const session of proposals) {
        // eslint-disable-next-line no-await-in-loop
        const synced = await prImportSync.syncImportedProposal({ config, pool, session });
        log.info('github-webhook', 'Pull request event applied', {
          sessionId: session.id, app: session.app_slug, prNumber, action, synced,
        });
      }
    } catch (err) {
      // The sweep is still the safety net, so a failure here is a delay and
      // not a loss. Logged, never rethrown into an already-answered request.
      log.warn('github-webhook', 'Handling failed; the sweep will pick it up', {
        fullName, prNumber, action, err: err.message,
      });
    }
  });

  return router;
}

module.exports = {
  githubWebhookRoutes,
  // Exported for the tests: the signature check and the repository match are
  // the two things that must not drift.
  signatureMatches,
  repoKey,
  findProposals,
  HANDLED_ACTIONS,
  MAX_BODY_BYTES,
};
