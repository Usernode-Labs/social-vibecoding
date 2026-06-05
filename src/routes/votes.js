const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const staging = require('../services/staging');
const docker = require('../services/docker');
const { checkAndResolveConflicts, resolveAndMaybeRetry } = require('../services/conflict-resolver');
const { sendSystemMessage, pushNotificationToUser } = require('../services/ws');
const { getActiveUserStats, isUserActive } = require('../services/active-users');
const notifications = require('../services/notifications');
const { isAppLocked, hasAdminYesVote } = require('../services/admin-approval');
const events = require('../services/events');

function voteRoutes(config) {
  const router = Router();
  const pool = getPool(config);

  // Promote a session's PR for voting
  router.post('/api/sessions/:id/promote', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.name as app_name, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.user_id = $2 AND cs.status = 'active'`,
        [req.params.id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Active session not found' });
      const session = rows[0];

      // Mark PR as ready for review on GitHub. We deliberately DO NOT
      // touch the title here — previously this overwrote the LLM-
      // generated title back to "<user>'s changes" every time a PR
      // was promoted, wiping the more descriptive title.
      if (github.isEnabled() && session.repo_url && session.pr_number) {
        try {
          const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
          if (owner && repo) {
            // octokit.request rather than .rest.pulls.update —
            // @octokit/app's installation Octokit is a bare core
            // instance without the rest-endpoint-methods plugin, so
            // .rest is undefined.
            const octokit = await github.getInstallationOctokit(owner);
            await octokit.request(
              'PATCH /repos/{owner}/{repo}/pulls/{pull_number}',
              { owner, repo, pull_number: session.pr_number, draft: false }
            );
          }
        } catch (err) {
          log.warn('votes', 'Failed to update PR on GitHub', { err: err.message });
        }
      }

      // promoted_at anchors the stale-PR sweeper's "no interest since"
      // clock; clearing stale_notified_at handles the re-promote case
      // (a previously-stale PR that's proposed again starts fresh).
      await pool.query(
        `UPDATE chat_sessions SET status = 'promoted', promoted_at = NOW(), stale_notified_at = NULL WHERE id = $1`,
        [session.id]
      );

      // Post to group chat. Include the PR title when we have one so
      // the feed reads like "evan promoted PR #8 — Add emoji stamp
      // centering fix for voting" instead of the opaque "PR #8 for
      // voting" which gives no hint about what's being voted on.
      const promoLabel = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} promoted ${promoLabel} for voting`,
        'vote',
        // Lets the group-chat client render live vote buttons inline on
        // this activity row (see group-chat.js renderMessageHtml).
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } }
      );

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'promoted', sessionId: session.id, appSlug: session.app_slug });
      log.info('votes', 'Session promoted', { sessionId: session.id });
      events.record(pool, {
        type: events.EVENT_TYPES.PR_PROMOTED,
        userId: req.user.id,
        appId: session.app_id,
        sessionId: session.id,
        metadata: { prNumber: session.pr_number || null },
      });
      res.json({ ok: true });

      // Vote-request fan-out. Non-fatal + post-response: the promote
      // itself has already succeeded, so a notification hiccup must not
      // 500 the request. Pings the app's active users + creator +
      // favoriters (minus the proposer) so the right people come vote,
      // and de-dupes per session so a re-promote doesn't re-spam.
      try {
        const notifRows = await notifications.createPrProposedNotifications(pool, {
          appId: session.app_id,
          sessionId: session.id,
          proposerId: req.user.id,
        });
        for (const row of notifRows) {
          pushNotificationToUser(row.user_id, {
            type: 'notification_new',
            notification: notifications.serialize({
              ...row,
              app_slug: session.app_slug,
              app_name: session.app_name,
              pr_title: session.pr_title,
              pr_number: session.pr_number,
              source_username: req.user.username,
            }),
          });
        }
        if (notifRows.length) {
          log.info('votes', 'PR-proposed notifications sent', {
            sessionId: session.id, count: notifRows.length,
          });
        }
      } catch (err) {
        log.warn('votes', 'pr_proposed notify failed', { sessionId: session.id, err: err.message });
      }
    } catch (err) {
      log.error('votes', 'Promote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Cast a vote on a promoted PR
  router.post('/api/sessions/:id/vote', async (req, res) => {
    const { vote } = req.body;
    if (!['yes', 'no'].includes(vote)) {
      return res.status(400).json({ error: 'Vote must be "yes" or "no"' });
    }

    try {
      // Accept votes on 'promoted' OR 'merging' sessions — once a merge
      // has started, a user flipping their vote shouldn't 404. But we
      // only *do* anything with the vote (chat message, merge check) if
      // it actually changed; see below.
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url,
                a.self_hosted as app_self_hosted
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status IN ('promoted', 'merging')`,
        [req.params.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Promoted session not found' });
      const session = sessionRows[0];

      // Was this a new vote, or a flip? Distinguishing matters because
      // without this, a user mashing "Yes" would post the same
      // "X voted yes on PR #N" line to group chat every time AND fire a
      // fresh checkAndMerge on every click — which, before the merge
      // concurrency guard, caused 7× parallel GitHub merges + docker
      // rebuilds stepping on each other's tempdirs and container names.
      // The DB upsert itself is still safe (UNIQUE(session_id,user_id))
      // but we avoid the side-effects on a no-op.
      const { rows: prevRows } = await pool.query(
        `SELECT vote FROM pr_votes WHERE session_id = $1 AND user_id = $2`,
        [session.id, req.user.id]
      );
      const previousVote = prevRows[0]?.vote || null;
      const unchanged = previousVote === vote;

      await pool.query(
        `INSERT INTO pr_votes (session_id, user_id, vote) VALUES ($1, $2, $3)
         ON CONFLICT (session_id, user_id) DO UPDATE SET vote = EXCLUDED.vote, created_at = NOW()`,
        [session.id, req.user.id, vote]
      );

      // Any voting activity revives a going-stale PR: clear the warning
      // flag so the stale sweeper restarts its clock instead of archiving.
      if (session.stale_notified_at) {
        await pool.query(
          `UPDATE chat_sessions SET stale_notified_at = NULL WHERE id = $1`,
          [session.id]
        );
      }

      if (unchanged) {
        log.debug('votes', 'Vote unchanged, skipping broadcast+merge', {
          sessionId: session.id, userId: req.user.id, vote,
        });
        return res.json({ ok: true, merged: false, unchanged: true });
      }

      const voteLabel = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${req.user.username} voted ${vote} on ${voteLabel}`,
        'vote',
        // Lets the group-chat client render live vote buttons inline on
        // this activity row (see group-chat.js renderMessageHtml).
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } }
      );

      // Broadcast the new tally *before* we try to merge, and respond
      // to the voter right away. checkAndMerge can take 30+ seconds on
      // the majority path (GitHub merge + prod rebuild + staging
      // teardown) and blocking on it here meant:
      //   - every other user's vote count sat stale until merge
      //     finished, which looked like "votes don't update live",
      //   - the voter's own UI sat mid-click with a spinning button
      //     while the merge ran, sometimes for the full 30s.
      // The merge itself still runs atomically (checkAndMerge claims
      // the session via 'promoted' → 'merging'), so kicking it into
      // the background doesn't change correctness.
      const { pushVoteUpdate } = require('../services/ws');
      pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: false });
      log.info('votes', 'Vote cast', { sessionId: session.id, vote, userId: req.user.id });

      // Emit only on a real (new or flipped) vote — the `unchanged`
      // no-op already returned above. pr_vote_cast credits the voter;
      // pr_vote_received credits the PR author (when still attributed),
      // so the PR-promotion funnel can measure "got a vote" reach.
      events.record(pool, {
        type: events.EVENT_TYPES.PR_VOTE_CAST,
        userId: req.user.id,
        appId: session.app_id,
        sessionId: session.id,
        metadata: { vote },
      });
      if (session.user_id && session.user_id !== req.user.id) {
        events.record(pool, {
          type: events.EVENT_TYPES.PR_VOTE_RECEIVED,
          userId: session.user_id,
          appId: session.app_id,
          sessionId: session.id,
          metadata: { vote, voterId: req.user.id },
        });
      }
      res.json({ ok: true, merged: false });

      // Kick off the majority check in the background. If it turns
      // into a merge, we send a second broadcast so clients flip the
      // PR out of the vote panel and update the "merged" list.
      checkAndMerge(config, pool, session)
        .then((mergeResult) => {
          if (mergeResult?.merged) {
            pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
          }
        })
        .catch((err) => {
          log.error('votes', 'Background merge failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('votes', 'Vote failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Get vote tally for a session
  router.get('/api/sessions/:id/votes', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT pv.vote, u.username
         FROM pr_votes pv JOIN users u ON pv.user_id = u.id
         WHERE pv.session_id = $1`,
        [req.params.id]
      );

      const yes = rows.filter((r) => r.vote === 'yes');
      const no = rows.filter((r) => r.vote === 'no');

      res.json({ yes: yes.map((r) => r.username), no: no.map((r) => r.username) });
    } catch (err) {
      log.error('votes', 'Failed to get votes', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List promoted sessions (for the vote panel in group chat)
  router.get('/api/apps/:slug/promoted', async (req, res) => {
    try {
      const { rows: appRows } = await pool.query('SELECT id, locked FROM apps WHERE slug = $1', [req.params.slug]);
      if (!appRows.length) return res.status(404).json({ error: 'App not found' });

      const userId = req.user?.id || null;
      // Include 'merging' alongside 'promoted' so the PR stays visible
      // during the GitHub merge + prod rebuild + staging teardown
      // pipeline (~30s). Otherwise the card disappears the instant the
      // majority threshold is crossed and only reappears in the "merged"
      // list at the very end, making it look like the vote was lost.
      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.staging_url, cs.user_id, cs.status, u.username, cs.created_at,
           (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') as yes_count,
           (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'no') as no_count,
           (SELECT vote FROM pr_votes WHERE session_id = cs.id AND user_id = $2) as my_vote,
           -- Kudos counts piggy-back on this query so the vote panel
           -- doesn't fan out to N extra round-trips per PR card. The
           -- (session_id, giver_user_id) UNIQUE constraint makes EXISTS
           -- a single-index probe; COUNT runs against the per-session
           -- index added in schema.sql.
           (SELECT COUNT(*)::int FROM pr_kudos WHERE session_id = cs.id) as kudos_count,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)) as my_kudos,
           -- #11: revert_of_session_id is non-null on PRs that are
           -- themselves a git-revert of an earlier merged PR. The
           -- vote panel uses this to render a Revert label
           -- instead of the regular title so voters know what they
           -- are voting on.
           cs.revert_of_session_id,
           orig.pr_number as original_pr_number,
           orig.pr_title  as original_pr_title
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions orig ON orig.id = cs.revert_of_session_id
         WHERE cs.app_id = $1 AND cs.status IN ('promoted', 'merging')
         ORDER BY cs.created_at DESC`,
        [appRows[0].id, userId]
      );

      const { active: activeUsers, majority } = await getActiveUserStats(pool, appRows[0].id);
      // Whether the viewer themself counts as active for this app —
      // surfaced on the group-chat dashboard so they can see their
      // own status and (if not counted) understand what to do about
      // it. Cheap query (two EXISTS lookups), runs alongside the
      // existing active-stats query.
      const viewerActive = await isUserActive(pool, appRows[0].id, userId);

      res.json({
        promoted: rows,
        activeUsers,
        majority,
        viewerActive,
        // Surfaced so the vote panel can render the "(locked — also
        // needs an admin yes)" hint on the Open PRs / Rename proposals
        // sections without a second round-trip. See loadVotePanel in
        // public/js/app-view.js.
        locked: !!appRows[0].locked,
      });
    } catch (err) {
      log.error('votes', 'Failed to list promoted', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // List merged sessions
  router.get('/api/apps/:slug/merged', async (req, res) => {
    try {
      const { rows: appRows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [req.params.slug]);
      if (!appRows.length) return res.status(404).json({ error: 'App not found' });

      const userId = req.user?.id || null;
      // Same kudos subqueries as /promoted so the merged card can show
      // its count + per-viewer "you gave kudos" state without a second
      // round-trip per row. cs.user_id is also surfaced so the FE
      // kudos button can disable itself client-side for self-PRs
      // (server still 403s as authority).
      //
      // #11/#16: surfaces the revert-session metadata (pr_number, status)
      // when one exists — so the UI can render "Undone by PR #N" /
      // "Revert in vote (PR #N)" labels without a per-row round-trip.
      // (Undo is now a single direct action that opens a revert PR, so
      // there are no separate undo-vote tallies to surface.)
      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, cs.user_id, cs.status, u.username, cs.created_at,
           cs.revert_of_session_id,
           -- Vote tally + per-viewer vote carried through so the group-chat
           -- activity row can keep its "x / y" pill and "You voted X" box
           -- after the PR merges (status='merged'), rather than the controls
           -- vanishing. Mirrors the /promoted subqueries.
           (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'yes') as yes_count,
           (SELECT COUNT(*) FROM pr_votes WHERE session_id = cs.id AND vote = 'no') as no_count,
           (SELECT vote FROM pr_votes WHERE session_id = cs.id AND user_id = $2) as my_vote,
           (SELECT COUNT(*)::int FROM pr_kudos WHERE session_id = cs.id) as kudos_count,
           (SELECT EXISTS(SELECT 1 FROM pr_kudos WHERE session_id = cs.id AND giver_user_id = $2)) as my_kudos,
           rv.id        as revert_session_id,
           rv.pr_number as revert_pr_number,
           rv.pr_url    as revert_pr_url,
           rv.status    as revert_status
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
         LEFT JOIN chat_sessions rv ON rv.revert_of_session_id = cs.id
           AND rv.status IN ('promoted', 'merging', 'merged')
         WHERE cs.app_id = $1 AND cs.status = 'merged'
         ORDER BY cs.created_at DESC
         LIMIT 20`,
        [appRows[0].id, userId]
      );

      res.json({ merged: rows });
    } catch (err) {
      log.error('votes', 'Failed to list merged', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── #11/#16: undo a merged PR by opening a revert PR ───────────────
  //
  // Undo is symmetric with proposing a forward change: a single click
  // opens a revert PR (clone repo, `git revert <merge_sha>`, push, open
  // PR), inserted as a `promoted` session, which then goes through the
  // SAME merge vote as any other PR. There is no separate "undo vote"
  // gate anymore (#16) — previously undo was double-gated (a majority to
  // open the revert, then a second majority to merge it), which was
  // confusing and redundant. The merge vote on the revert PR is now the
  // single checkpoint, mirroring the forward propose→vote flow.
  //
  // The caller becomes the revert session's owner (user_id) so they
  // "own" the resulting PR for chat / status purposes.
  router.post('/api/sessions/:id/undo', async (req, res) => {
    try {
      const { rows: sessionRows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status = 'merged'`,
        [req.params.id]
      );
      if (!sessionRows.length) return res.status(404).json({ error: 'Merged session not found' });
      const session = sessionRows[0];

      // Revert PRs are not themselves undoable — would create an endless
      // undo-undo-undo loop. The button is hidden on the client already;
      // this is the server-side enforcement.
      if (session.revert_of_session_id) {
        return res.status(409).json({ error: 'Cannot undo a revert PR' });
      }

      // Block if a revert is already in flight or landed for this merge.
      const { rows: existingRevert } = await pool.query(
        `SELECT id, status, pr_number, pr_url FROM chat_sessions
         WHERE revert_of_session_id = $1 AND status IN ('promoted', 'merging', 'merged')
         ORDER BY id DESC LIMIT 1`,
        [session.id]
      );
      if (existingRevert.length) {
        const rv = existingRevert[0];
        return res.status(409).json({
          error: `A revert PR for this merge already exists (status: ${rv.status})`,
          revertSessionId: rv.id,
          revertPrNumber: rv.pr_number,
          revertPrUrl: rv.pr_url,
        });
      }

      log.info('votes', 'Undo requested — opening revert PR', {
        sessionId: session.id, by: req.user.username,
      });
      // Respond immediately; the revert (clone + git revert + push + PR)
      // runs in the background and announces itself in group chat. The
      // vote panel refreshes via the pushVoteUpdate broadcast below.
      res.json({ ok: true, opening: true });

      const { pushVoteUpdate } = require('../services/ws');
      checkAndOpenRevert(config, pool, session, req.user)
        .then((result) => {
          if (result?.reverted) {
            pushVoteUpdate({
              sessionId: session.id,
              appSlug: session.app_slug,
              merged: false,
              kind: 'undo',
              revertSessionId: result.revertSessionId,
              revertPrNumber: result.revertPrNumber,
            });
          }
        })
        .catch((err) => {
          log.error('votes', 'Background revert failed', { sessionId: session.id, err: err.message });
        });
    } catch (err) {
      log.error('votes', 'Undo failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Admin force-merge ─────────────────────────────────────────────
  //
  // Admin-only escape hatch: merge a promoted PR right now, regardless
  // of vote tally or the locked-app admin-yes gate. Used when an admin
  // is confident the change should ship and doesn't want to wait for
  // the active-user majority. The frontend gates this behind a
  // ConfirmModal so a misclick can't accidentally bypass voting.
  //
  // The actual merge pipeline (atomic 'promoted → merging' claim,
  // GitHub merge, prod rebuild, staging teardown, broadcasts) is the
  // same `checkAndMerge` path the regular vote route uses — we just
  // pass `force: true` to skip the early gates. The chat message
  // distinguishes the override so users see who did it and why a PR
  // landed without the usual tally.
  router.post('/api/sessions/:id/admin-merge', async (req, res) => {
    if (!req.user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    try {
      const { rows } = await pool.query(
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url,
                a.self_hosted as app_self_hosted
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
         WHERE cs.id = $1 AND cs.status = 'promoted'`,
        [req.params.id]
      );
      if (!rows.length) {
        return res.status(404).json({ error: 'Promoted session not found' });
      }
      const session = rows[0];

      // Respond immediately; the merge itself runs in the background
      // exactly like the regular vote-driven path. Clients refresh via
      // the `pushVoteUpdate` broadcasts emitted by checkAndMerge.
      log.info('votes', 'Admin force-merge requested', {
        sessionId: session.id, by: req.user.username,
      });
      res.json({ ok: true, queued: true });

      checkAndMerge(config, pool, session, { force: true, forceBy: req.user })
        .then((mergeResult) => {
          if (mergeResult?.merged) {
            const { pushVoteUpdate } = require('../services/ws');
            pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: true });
          }
        })
        .catch((err) => {
          log.error('votes', 'Admin force-merge failed', {
            sessionId: session.id, err: err.message,
          });
        });
    } catch (err) {
      log.error('votes', 'Admin force-merge route failed', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

// `options.force` (admin force-merge): skip the vote-count, locked-app
// admin-yes, and behind_main gates entirely and proceed straight to the
// claim+merge pipeline. The atomic `promoted → merging` claim still
// races against any concurrent vote-driven merge, so we won't double-
// merge. `options.forceBy` is the admin user object (id, username) used
// for the "merged by <admin> overriding vote" chat message.
async function checkAndMerge(config, pool, session, options = {}) {
  // `options.autoResolve` (default true): when a merge is blocked by a
  // conflict / behind-main, kick off the worker-based auto-resolver
  // (sync with main + retry). The resolver re-invokes checkAndMerge with
  // autoResolve:false so its own conflict paths don't re-trigger the
  // resolver — this bounds the resolve+retry to a single cycle.
  const { force = false, forceBy = null, autoResolve = true } = options;
  const { active: activeCount, majority } = await getActiveUserStats(pool, session.app_id);

  const { rows: yesRows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM pr_votes WHERE session_id = $1 AND vote = 'yes'`,
    [session.id]
  );
  const yesCount = parseInt(yesRows[0].cnt);

  if (!force) {
    if (yesCount < majority) {
      return { merged: false, yesCount, needed: majority };
    }

    // Locked apps additionally require at least one admin yes vote (see
    // services/admin-approval.js + the apps.locked column). The active-user
    // majority gate above still has to pass — the admin yes is an extra
    // condition, not a replacement. Toggled via the home-card lock icon
    // (admin-only); see POST /api/apps/:slug/lock in routes/apps.js.
    if (await isAppLocked(pool, session.app_id)) {
      const adminYes = await hasAdminYesVote(pool, session.id);
      if (!adminYes) {
        log.info('votes', 'Majority reached but app is locked; awaiting admin yes', {
          sessionId: session.id, yesCount, majority,
        });
        return { merged: false, yesCount, needed: majority, awaitingAdmin: true };
      }
    }

    // #8: refuse the merge if the branch is behind origin/main. We don't
    // auto-spawn a sync turn from here because:
    //   1. Charging the sync to the voter who happened to push us over
    //      the threshold is unfair — the cost should land on the
    //      session owner who controls the branch.
    //   2. Auto-spawning would add ~30-90s latency to the merge with no
    //      visible feedback to the voter who triggered it.
    // Instead, surface in group chat that the owner needs to click
    // "Sync with main" in their dev-chat. The next yes vote will
    // re-attempt the merge, which succeeds once behind_main=0.
    if ((session.behind_main || 0) > 0) {
      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${label} is ${session.behind_main} commit${session.behind_main === 1 ? '' : 's'} behind main — syncing automatically and will retry the merge. ${owner}: you can also resolve it from the session's dev-chat.`,
        'system'
      );
      log.info('votes', 'Merge blocked: branch behind main', {
        sessionId: session.id, behind: session.behind_main,
      });
      // Auto-heal: sync the branch with main (worker git-merge +
      // Claude-on-markers) and retry the merge. The PR keeps its votes
      // because the sync push doesn't go through the vote-resetting
      // dev-turn path. Fire-and-forget so the voter's request returns
      // immediately.
      if (autoResolve) {
        resolveAndMaybeRetry(config, { session }).catch((err) => {
          log.error('votes', 'Auto-resolve (behind_main) failed', {
            sessionId: session.id, err: err.message,
          });
        });
      }
      return { merged: false, yesCount, needed: majority, behindMain: session.behind_main };
    }
  }
  // For admin force-merge we deliberately skip the behind_main pre-check
  // — GitHub will still reject the merge if there's a real conflict,
  // and the catch-block below surfaces that the same way it does for
  // votes. Admins overriding the vote can decide whether to push the
  // branch sync themselves.

  // Majority reached. Try to claim the merge by atomically flipping
  // status 'promoted' → 'merging'. Only one concurrent caller will
  // win this; everyone else bails out. This guards against the
  // previous bug where hammering "Yes" fired N parallel merge+rebuild
  // pipelines that stomped on each other (GitHub lock, /tmp/usernode-
  // rebuild-* git clone races, duplicate `docker run --name ...`, etc).
  const { rows: claim } = await pool.query(
    `UPDATE chat_sessions SET status = 'merging'
     WHERE id = $1 AND status = 'promoted'
     RETURNING id`,
    [session.id]
  );
  if (!claim.length) {
    log.info('votes', 'Merge already claimed by another request, skipping', {
      sessionId: session.id,
    });
    return { merged: false, inProgress: true };
  }

  // Broadcast the 'merging' transition so every client refreshes its
  // vote panel and re-renders the PR as "Merging…" — rather than having
  // it silently disappear between the vote and the eventual 'merged'
  // state (30s+ on the majority path). `merged:false` here means "still
  // in flight"; the final `merged:true` broadcast fires below after the
  // GitHub merge + prod rebuild + staging teardown finish.
  //
  // SELF-HOSTING.md Phase 3: `selfHosted` rides along so clients
  // can latch into the "platform updating…" banner state at the moment
  // the merge starts. We can't rely on the post-merge
  // `app_version_changed` event for self-hosted apps because the GHA
  // rolling restart that follows drops the WebSocket — clients persist
  // the banner in sessionStorage on this event and dismiss it once
  // /api/version reports a different SHA. See public/js/app.js
  // (handleVoteUpdate / beginPlatformUpdating).
  const { pushVoteUpdate } = require('../services/ws');
  pushVoteUpdate({
    sessionId: session.id,
    appSlug: session.app_slug,
    merged: false,
    merging: true,
    selfHosted: !!session.app_self_hosted,
  });

  log.info('votes',
    force ? 'Admin force-merge invoked, merging' : 'Majority reached, merging',
    {
      sessionId: session.id, yesCount, needed: majority,
      ...(force && forceBy ? { forcedBy: forceBy.username } : {}),
    });

  let mergeCommitSha = null;

  try {
    // Merge PR on GitHub
    if (github.isEnabled() && session.repo_url && session.pr_number) {
      const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (owner && repo) {
        const mergeData = await github.mergePR(owner, repo, session.pr_number);
        // #11: capture the squash-merge commit SHA so future vote-to-undo
        // can `git revert <sha>` against main. The Octokit `pulls.merge`
        // response shape is { sha, merged: true, message }.
        mergeCommitSha = mergeData?.sha || null;
      }
    }

    // Rebuild production
    const { rows: appRows } = await pool.query('SELECT * FROM apps WHERE id = $1', [session.app_id]);
    const app = appRows[0];

    if (app) {
      let sha = null;
      // SELF-HOSTING.md sub-step 2g (Guard B): for the self-app,
      // there's no platform-managed prod container to rebuild — the
      // GitHub Actions deploy workflow rolls the harness when the merge
      // lands on main. Skip rebuildProduction entirely, but keep the
      // app_version_changed broadcast firing so Phase 3's banner has its
      // hook. main_sha is refreshed by seedSelfApp() on the next boot,
      // which clients pick up via /api/version.
      if (!app.self_hosted) {
        const result = await staging.rebuildProduction(config, app);
        sha = result.sha;
        // Also record the SHA + originating PR so the main app view can
        // show "live on <sha> · PR #<n>" (#21). pr_number comes from the
        // session we just merged; sha is what `rebuildProduction` cloned.
        await pool.query(
          `UPDATE apps SET container_id = $1, main_sha = $2, main_pr_number = $3,
                           last_deploy_at = NOW()
           WHERE id = $4`,
          [result.containerId, sha || null, session.pr_number || null, app.id]
        );
      } else {
        log.info('votes', 'Self-app PR merged; GitHub Actions auto-deploy will roll', {
          appId: app.id, prNumber: session.pr_number,
        });
      }
      // Let every tab watching this app refresh its commit pill without
      // polling. The existing vote_update event already fires on merge
      // but is scoped to vote panel refreshes; a dedicated event keeps
      // the concerns separated and avoids over-broadcasting. Fires for
      // self-hosted too (sha=null) so the future banner can detect
      // "platform updating" without a sha to anchor to.
      try {
        const { broadcastGlobal } = require('../services/ws');
        broadcastGlobal({
          type: 'app_version_changed',
          appSlug: session.app_slug,
          sha: sha || null,
          prNumber: session.pr_number || null,
        });
      } catch {}
    }

    // Teardown staging
    await staging.teardownStaging(session, app);

    await pool.query(
      `UPDATE chat_sessions SET status = 'merged', merged_at = NOW(),
                                merge_commit_sha = COALESCE($2, merge_commit_sha)
       WHERE id = $1`,
      [session.id, mergeCommitSha]
    );

    // pr_merged is the terminal stage of the PR-promotion funnel and the
    // signal behind the "merges over time" growth chart (now exact thanks
    // to merged_at above). Attributed to the PR author (session.user_id),
    // which may be NULL if the author was deleted.
    events.record(pool, {
      type: events.EVENT_TYPES.PR_MERGED,
      userId: session.user_id || null,
      appId: session.app_id,
      sessionId: session.id,
      metadata: {
        prNumber: session.pr_number || null,
        forced: !!force,
        ...(force && forceBy ? { forcedBy: forceBy.username } : {}),
      },
    });

    // Chat session is done — no further turns will reference CC memory,
    // so drop the persistent `.claude` volume.
    try {
      const worker = require('../services/worker');
      await worker.destroyCcVolume(session.id);
    } catch (err) {
      log.warn('votes', 'Failed to destroy CC volume', { sessionId: session.id, err: err.message });
    }

    // Announce in group chat
    const mergedLabel = session.pr_title
      ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
      : `PR #${session.pr_number || session.id}`;
    const mergedSuffix = force && forceBy
      ? `force-merged by admin ${forceBy.username} (${yesCount}/${activeCount} vote${yesCount === 1 ? '' : 's'} at the time)`
      : `merged and deployed! (${yesCount}/${activeCount} votes)`;
    await sendSystemMessage(pool, session.app_id,
      `${mergedLabel} ${mergedSuffix}`,
      'system'
    );

    // Check for conflicts on other promoted PRs and resolve them
    checkAndResolveConflicts(config, session).catch((err) => {
      log.error('votes', 'Conflict resolution check failed', { err: err.message });
    });

    return { merged: true };
  } catch (err) {
    log.error('votes', 'Merge failed', { sessionId: session.id, err: err.message });
    // Release the 'merging' claim so a subsequent vote (or retry) can
    // try again. Without this the session would be stuck in 'merging'
    // forever on any transient failure.
    await pool.query(
      `UPDATE chat_sessions SET status = 'promoted'
       WHERE id = $1 AND status = 'merging'`,
      [session.id]
    ).catch(() => {});

    // #9: detect GitHub's "merge conflict" rejection specifically.
    // Octokit returns status 405 with a message containing "merge
    // conflict" or "not mergeable" when `pulls.merge` is called on
    // an unmergeable PR. The pre-merge gate in checkAndMerge catches
    // the common case (our recorded behind_main > 0), but races
    // (another PR merging in the window between our last sync and
    // the vote crossing threshold) can slip past it. When that
    // happens, our local behind_main is stale (= 0) but the branch
    // really is behind main, so we:
    //   1. Bump behind_main to at least 1 so the dev-chat banner
    //      reappears for the owner. The next worker turn will
    //      recompute the exact count.
    //   2. Broadcast session_update(behind_main) so any open dev-chat
    //      banner refreshes in place.
    //   3. Post a tailored group-chat message that matches the
    //      pre-merge gate's wording, so the user knows it's a
    //      "owner needs to click Sync" situation rather than a
    //      mysterious GitHub blowup.
    const msg = String(err.message || '').toLowerCase();
    const isConflict =
      err.status === 405 ||
      msg.includes('merge conflict') ||
      msg.includes('not mergeable') ||
      msg.includes('pull request is not mergeable');

    if (isConflict) {
      try {
        const { rows: bumpRows } = await pool.query(
          `UPDATE chat_sessions SET behind_main = GREATEST(behind_main, 1)
           WHERE id = $1 RETURNING behind_main`,
          [session.id]
        );
        const newBehind = bumpRows[0]?.behind_main || 1;
        try {
          const { pushSessionUpdate } = require('../services/ws');
          pushSessionUpdate({
            action: 'behind_main',
            sessionId: session.id,
            appSlug: session.app_slug,
            behindMain: newBehind,
          });
        } catch (_) { /* ws failures non-fatal */ }
      } catch (_) { /* DB bump failures non-fatal — chat msg still goes out */ }

      const owner = session.user_id ? `<@${session.user_id}>` : 'the session owner';
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `${label} hit a conflict with main — syncing automatically and will retry the merge. ${owner}: you can also resolve it from the session's dev-chat.`,
        'system'
      );
      // Auto-heal the conflict the same way the behind_main gate does.
      // autoResolve guards against the resolver's own retry re-entering
      // this path (it calls checkAndMerge with autoResolve:false).
      if (autoResolve) {
        resolveAndMaybeRetry(config, { session }).catch((e) => {
          log.error('votes', 'Auto-resolve (merge conflict) failed', {
            sessionId: session.id, err: e.message,
          });
        });
      }
    } else {
      await sendSystemMessage(pool, session.app_id,
        `Failed to merge PR #${session.pr_number || session.id}: ${err.message}`,
        'system'
      );
    }
    return { merged: false, error: err.message, conflict: isConflict };
  }
}

// #11/#16: undo helper. Called from the /undo route. Opens a revert PR
// for a merged session (clone, `git revert <merge_sha>`, push, open PR)
// and inserts a `promoted` chat_sessions row for it that then goes
// through the normal merge vote. As of #16 there's no undo-vote gate —
// the merge vote on the revert PR is the single checkpoint.
//
// `decider` is the user who requested the undo — becomes the revert
// session's user_id so they own the resulting PR in dev-chat.
async function checkAndOpenRevert(config, pool, session, decider) {
  // #16: opening a revert is now a direct action (like proposing a
  // forward change) — there's no separate undo-vote gate to clear. We
  // still read activeCount/majority so the announcement can tell users
  // how many votes the revert PR will need to actually land. The
  // locked-app admin-yes gate is NOT applied here: it's a merge-time
  // control and is enforced when the revert PR's own merge vote is
  // tallied (checkAndMerge), exactly like a forward proposal.
  const { active: activeCount, majority } = await getActiveUserStats(pool, session.app_id);

  // Atomic claim — race-safe against parallel undo requests. We mark
  // the original session with revert_of_session_id = its own id as a
  // sentinel "claimed" value; the real revert session id swaps in
  // below once we have it. The WHERE NULL guarantees only one caller
  // wins this transition.
  const { rows: claim } = await pool.query(
    `UPDATE chat_sessions SET revert_of_session_id = id
     WHERE id = $1 AND revert_of_session_id IS NULL
     RETURNING id`,
    [session.id]
  );
  if (!claim.length) {
    log.info('votes', 'Revert already claimed by another request, skipping', {
      sessionId: session.id,
    });
    return { reverted: false, inProgress: true };
  }

  // Sanity precondition: we need a merge SHA to revert. For pre-#11
  // merged rows the column is NULL because mergePR's response wasn't
  // captured at the time. GitHub still knows the SHA via pulls.get —
  // try to backfill on demand, persist for next time, and proceed.
  // Only fall through to the manual-revert message if GitHub can't
  // help either (auth disabled, repo gone, PR never actually merged,
  // etc.).
  if (!session.merge_commit_sha) {
    let backfilledSha = null;
    let backfillReason = 'unknown';
    if (!github.isEnabled()) {
      backfillReason = 'GitHub auth not configured on this deployment';
    } else if (!session.repo_url) {
      backfillReason = 'session has no repo_url';
    } else if (!session.pr_number) {
      backfillReason = 'session has no pr_number';
    } else {
      const bm = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!bm) {
        backfillReason = `unparseable repo_url ${session.repo_url}`;
      } else {
        const [, bOwner, bRepo] = bm;
        try {
          // Use octokit.request rather than octokit.rest.pulls.get —
          // @octokit/app's installation octokit is a bare @octokit/core
          // instance and does not include the rest-endpoint-methods
          // plugin, so .rest is undefined.
          const octokit = await github.getInstallationOctokit(bOwner);
          const { data: pr } = await octokit.request(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}',
            { owner: bOwner, repo: bRepo, pull_number: session.pr_number }
          );
          if (pr.merged && pr.merge_commit_sha) {
            await pool.query(
              `UPDATE chat_sessions SET merge_commit_sha = $2
               WHERE id = $1 AND merge_commit_sha IS NULL`,
              [session.id, pr.merge_commit_sha]
            );
            session.merge_commit_sha = pr.merge_commit_sha;
            backfilledSha = pr.merge_commit_sha;
            log.info('votes', 'Backfilled merge_commit_sha from GitHub', {
              sessionId: session.id, prNumber: session.pr_number,
              sha: pr.merge_commit_sha,
            });
          } else {
            backfillReason = pr.merged
              ? 'GitHub returned a merged PR with no merge_commit_sha'
              : 'GitHub says this PR is not merged';
          }
        } catch (err) {
          backfillReason = `GitHub lookup failed: ${err.message}`;
          log.warn('votes', 'merge_commit_sha backfill from GitHub failed', {
            sessionId: session.id, prNumber: session.pr_number, err: err.message,
          });
        }
      }
    }

    if (!backfilledSha) {
      await pool.query(
        `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
        [session.id]
      ).catch(() => {});
      const label = session.pr_title
        ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
        : `PR #${session.pr_number || session.id}`;
      await sendSystemMessage(pool, session.app_id,
        `Couldn't auto-revert ${label}: ${backfillReason}. Please open the revert PR manually.`,
        'system'
      );
      return { reverted: false, error: 'no merge_commit_sha', backfillReason };
    }
  }
  if (!session.repo_url) {
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    return { reverted: false, error: 'no repo_url' };
  }

  const m = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) {
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    return { reverted: false, error: 'unparseable repo_url' };
  }
  const [, repoOwner, repoName] = m;

  log.info('votes', 'Opening revert PR', {
    sessionId: session.id, needed: majority, requestedBy: decider.username,
  });

  let revertInfo;
  try {
    revertInfo = await createRevertPR({
      session,
      mergeSha: session.merge_commit_sha,
      repoOwner,
      repoName,
      deciderUsername: decider.username,
    });
  } catch (err) {
    // Release the claim so a future vote can retry. Most common
    // failure here is `git revert` conflict — surface it clearly.
    await pool.query(
      `UPDATE chat_sessions SET revert_of_session_id = NULL WHERE id = $1`,
      [session.id]
    ).catch(() => {});
    log.error('votes', 'Revert PR creation failed', { sessionId: session.id, err: err.message });
    const label = session.pr_title
      ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
      : `PR #${session.pr_number || session.id}`;
    await sendSystemMessage(pool, session.app_id,
      `Couldn't auto-revert ${label}: ${err.message}. ` +
      `Most likely later commits depend on it. Please open the revert PR manually.`,
      'system'
    );
    return { reverted: false, error: err.message };
  }

  // Insert the revert session row. status=promoted means it lands
  // directly in the vote panel ready for a second checkpoint vote.
  const { rows: revertRows } = await pool.query(
    `INSERT INTO chat_sessions
       (app_id, user_id, branch_name, pr_number, pr_url, pr_title,
        status, revert_of_session_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'promoted', $7)
     RETURNING id`,
    [
      session.app_id, decider.id, revertInfo.branch,
      revertInfo.prNumber, revertInfo.prUrl, revertInfo.prTitle,
      session.id,
    ]
  );
  const revertSessionId = revertRows[0].id;

  // Patch the original's revert_of_session_id pointer to actually
  // point at the revert session (was set to its own id as a claim
  // sentinel above). Now `revert_of_session_id IS NOT NULL` on the
  // original correctly identifies "has a revert in flight".
  await pool.query(
    `UPDATE chat_sessions SET revert_of_session_id = $1 WHERE id = $2`,
    [revertSessionId, session.id]
  );

  // Announce in group chat so the new revert PR shows up in the vote
  // panel with context. Tag the original PR # for breadcrumbs.
  const label = session.pr_title
    ? `PR #${session.pr_number || session.id} — ${session.pr_title}`
    : `PR #${session.pr_number || session.id}`;
  await sendSystemMessage(pool, session.app_id,
    `${decider.username} proposed undoing ${label}. Opened revert PR #${revertInfo.prNumber} — needs ${majority}/${activeCount} votes to land.`,
    'system'
  );

  return {
    reverted: true,
    revertSessionId,
    revertPrNumber: revertInfo.prNumber,
    revertPrUrl: revertInfo.prUrl,
  };
}

// Clone the repo to a tmpdir, branch off main, `git revert <sha>`,
// push, open a PR. Returns { branch, prNumber, prUrl, prTitle }.
// Throws on revert conflict or network errors; caller surfaces the
// failure to chat.
async function createRevertPR({ session, mergeSha, repoOwner, repoName, deciderUsername }) {
  const token = process.env.GITHUB_BOT_TOKEN;
  if (!token) throw new Error('GITHUB_BOT_TOKEN not set');

  const cloneUrl = `https://x-access-token:${token}@github.com/${repoOwner}/${repoName}.git`;
  const tmpDir = `/tmp/usernode-revert-${session.id}-${Date.now()}`;
  // Branch naming pattern: revert/<original-branch>-<timestamp>. The
  // timestamp suffix avoids collisions if a prior revert attempt left
  // a stale branch on the remote.
  const safeBase = (session.branch_name || `pr-${session.pr_number || session.id}`).replace(/[^a-zA-Z0-9._/-]/g, '-');
  const revertBranch = `revert/${safeBase}-${Date.now()}`;

  try {
    // Full clone — we need history reaching back to the merge SHA, so
    // the rebuildProduction shallow-clone pattern doesn't apply here.
    await docker.execFileAsync('git', ['clone', cloneUrl, tmpDir], { timeout: 180000 });

    // Committer identity for the revert commit. Matches the
    // usernode-bot convention used elsewhere.
    await docker.execFileAsync('git', ['-C', tmpDir, 'config', 'user.name', 'usernode-bot']);
    await docker.execFileAsync('git', ['-C', tmpDir, 'config', 'user.email', 'usernode-bot@users.noreply.github.com']);

    // Branch off the current main. main has already been updated by
    // the original merge + any subsequent merges by the time we get
    // here, so this is the "current" main.
    await docker.execFileAsync('git', ['-C', tmpDir, 'checkout', '-b', revertBranch], { timeout: 10000 });

    // `git revert --no-edit <sha>` — squash merges produce single-parent
    // commits, so no `-m 1` needed. If the revert conflicts (later
    // commits depend on this one), git exits non-zero and the docker
    // helper rejects.
    try {
      await docker.execFileAsync('git', ['-C', tmpDir, 'revert', '--no-edit', mergeSha], { timeout: 30000 });
    } catch (revertErr) {
      // Clean up the conflicted state inside the tmp dir for hygiene
      // (best-effort), then surface a tight error.
      await docker.execFileAsync('git', ['-C', tmpDir, 'revert', '--abort']).catch(() => {});
      const m = String(revertErr.message || '').toLowerCase();
      if (m.includes('conflict')) {
        throw new Error('Revert produced merge conflicts');
      }
      throw new Error(`git revert failed: ${revertErr.message.slice(0, 200)}`);
    }

    await docker.execFileAsync('git', ['-C', tmpDir, 'push', '-u', 'origin', revertBranch], { timeout: 60000 });

    const origLabel = session.pr_title
      ? `${session.pr_title} (PR #${session.pr_number || session.id})`
      : `PR #${session.pr_number || session.id}`;
    const prTitle = `Revert: ${session.pr_title || `PR #${session.pr_number || session.id}`}`.slice(0, 200);
    const prBody =
      `Automated revert of ${origLabel}.\n\n` +
      `Undo vote reached majority on the original PR; deciding vote cast by @${deciderUsername}. ` +
      `This PR still needs a regular merge vote to land — vote in the app's group chat panel.\n\n` +
      `Reverts commit ${mergeSha}.`;

    const prData = await github.createPR(repoOwner, repoName, {
      branch: revertBranch,
      title: prTitle,
      body: prBody,
    });

    return {
      branch: revertBranch,
      prNumber: prData.number,
      prUrl: prData.html_url,
      prTitle,
    };
  } finally {
    await docker.execFileAsync('rm', ['-rf', tmpDir]).catch(() => {});
  }
}

// checkAndMerge is exported (in addition to voteRoutes) so the
// auto-conflict-resolver can re-attempt a merge for an already-approved
// PR after it syncs cleanly with main. Consumers should lazy-require
// this module from inside a function to avoid the votes <-> conflict-
// resolver circular-require load-order trap.
module.exports = { voteRoutes, checkAndMerge };
