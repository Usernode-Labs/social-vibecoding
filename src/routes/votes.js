const { Router } = require('express');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const staging = require('../services/staging');
const { checkAndResolveConflicts } = require('../services/conflict-resolver');
const { sendSystemMessage } = require('../services/ws');
const { getActiveUserStats, isUserActive } = require('../services/active-users');

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
            const octokit = await github.getInstallationOctokit(owner);
            await octokit.rest.pulls.update({
              owner, repo, pull_number: session.pr_number, draft: false,
            });
          }
        } catch (err) {
          log.warn('votes', 'Failed to update PR on GitHub', { err: err.message });
        }
      }

      await pool.query(
        `UPDATE chat_sessions SET status = 'promoted' WHERE id = $1`,
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
        'vote'
      );

      const { pushSessionUpdate } = require('../services/ws');
      pushSessionUpdate({ action: 'promoted', sessionId: session.id, appSlug: session.app_slug });
      log.info('votes', 'Session promoted', { sessionId: session.id });
      res.json({ ok: true });
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
        `SELECT cs.*, a.slug as app_slug, a.id as app_id, a.repo_url
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
        'vote'
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
      const { rows: appRows } = await pool.query('SELECT id FROM apps WHERE slug = $1', [req.params.slug]);
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
           (SELECT vote FROM pr_votes WHERE session_id = cs.id AND user_id = $2) as my_vote
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
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

      res.json({ promoted: rows, activeUsers, majority, viewerActive });
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

      const { rows } = await pool.query(
        `SELECT cs.id, cs.pr_number, cs.pr_url, cs.pr_title, u.username, cs.created_at
         FROM chat_sessions cs
         JOIN users u ON cs.user_id = u.id
         WHERE cs.app_id = $1 AND cs.status = 'merged'
         ORDER BY cs.created_at DESC
         LIMIT 20`,
        [appRows[0].id]
      );

      res.json({ merged: rows });
    } catch (err) {
      log.error('votes', 'Failed to list merged', { message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

async function checkAndMerge(config, pool, session) {
  const { active: activeCount, majority } = await getActiveUserStats(pool, session.app_id);

  const { rows: yesRows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM pr_votes WHERE session_id = $1 AND vote = 'yes'`,
    [session.id]
  );
  const yesCount = parseInt(yesRows[0].cnt);

  if (yesCount < majority) {
    return { merged: false, yesCount, needed: majority };
  }

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
  const { pushVoteUpdate } = require('../services/ws');
  pushVoteUpdate({ sessionId: session.id, appSlug: session.app_slug, merged: false, merging: true });

  log.info('votes', 'Majority reached, merging', { sessionId: session.id, yesCount, needed: majority });

  try {
    // Merge PR on GitHub
    if (github.isEnabled() && session.repo_url && session.pr_number) {
      const [, owner, repo] = session.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/) || [];
      if (owner && repo) {
        await github.mergePR(owner, repo, session.pr_number);
      }
    }

    // Rebuild production
    const { rows: appRows } = await pool.query('SELECT * FROM apps WHERE id = $1', [session.app_id]);
    const app = appRows[0];

    if (app) {
      const { containerId, sha } = await staging.rebuildProduction(config, app);
      // Also record the SHA + originating PR so the main app view can
      // show "live on <sha> · PR #<n>" (#21). pr_number comes from the
      // session we just merged; sha is what `rebuildProduction` cloned.
      await pool.query(
        `UPDATE apps SET container_id = $1, main_sha = $2, main_pr_number = $3,
                         last_deploy_at = NOW()
         WHERE id = $4`,
        [containerId, sha || null, session.pr_number || null, app.id]
      );
      // Let every tab watching this app refresh its commit pill without
      // polling. The existing vote_update event already fires on merge
      // but is scoped to vote panel refreshes; a dedicated event keeps
      // the concerns separated and avoids over-broadcasting.
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
      `UPDATE chat_sessions SET status = 'merged' WHERE id = $1`,
      [session.id]
    );

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
    await sendSystemMessage(pool, session.app_id,
      `${mergedLabel} was merged and deployed! (${yesCount}/${activeCount} votes)`,
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
    await sendSystemMessage(pool, session.app_id,
      `Failed to merge PR #${session.pr_number || session.id}: ${err.message}`,
      'system'
    );
    return { merged: false, error: err.message };
  }
}

module.exports = { voteRoutes };
