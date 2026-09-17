const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const staging = require('../services/staging');
const ws = require('../services/ws');
const notifications = require('../services/notifications');
const notificationPreferences = require('../services/notification-preferences');
const activeUsers = require('../services/active-users');
const appAccess = require('../services/app-access');
const events = require('../services/events');
const topicAttrs = require('../services/topic-attributes');
const usernames = require('../services/usernames');
const prImportSync = require('../services/pr-import-sync');
const sessionLifecycle = require('../services/session-lifecycle');
const { reviewedHeadForSession } = require('../services/pr-vote-revision');
const { drainGuard } = require('../services/lifecycle');
const votes = require('./votes');

// Demo mode — a synthetic partner, on one app, for recording the proposal
// flow.
//
// A recording of "somebody proposes a change, you get the notification, you
// preview it, you vote, it merges" needs a second participant who acts on
// cue, and it needs to be re-shootable: the app has to go back to where it
// started between takes. Asking a person to tap at the right moment twelve
// times is not a plan, and a script holding a real account's session is a
// credential lying around. So the second participant is SYNTHETIC: a users
// row the platform owns, that cannot sign in, and that acts only through the
// five routes here.
//
// ── Containment ───────────────────────────────────────────────────────
//
// This is the part worth being precise about. A triggerable account that
// proposes and votes is, in the wrong shape, a lever for manufacturing
// consent on a platform whose whole premise is that changes merge by group
// vote. Four things keep it the right shape:
//
//   1. The partner cannot authenticate. Its password is random and thrown
//      away, it has no OAuth link, and both the session middleware and the
//      login route refuse an is_synthetic row outright (middleware/auth.js,
//      routes/auth.js) — a session row that named it is no session.
//   2. Every route here checks the app is in demo mode AND the caller is
//      its creator. Not an admin, not an app admin: the creator. Demo mode
//      is a thing you do to your own app.
//   3. The platform's own app can never be in demo mode.
//   4. The partner's standing as a voter (services/active-users.js) is
//      written for the demo app only and removed when demo mode goes off.
//      It counts for nothing anywhere else.
//
// And it is marked: the app's settings dialog says the app is in demo mode
// and names the partner (routes/apps.js exposes demo_partner for that).
//
// ── What each route does ───────────────────────────────────────────────
//
// The proposal is REAL. demo/propose opens a pull request from a branch
// already on the app's repository, as the platform's own bot — the same
// authorship every connector submission has — and files it as an imported
// proposal owned by the partner, already promoted. Imported is the right
// source: the preview, checks, head-sync and merge machinery all key off it
// (services/pr-import-sync.js, checkAndMerge) and none of it needs a
// dev-chat worker. Then it does the one thing pr-import's own straight-to-
// vote path does not: the pr_proposed fan-out, which is the notification the
// viewer is waiting for.
//
// demo/vote records the partner's vote through recordVote and hands the
// session to checkAndMerge, exactly as routes/votes.js does for a person.
// demo/reset tears the partner's proposals down, puts main back to the
// commit demo mode was switched on at, and rebuilds production. GET demo
// lists what would silently spoil a take — the notification preference that
// defaults off, a creator who has not used the app lately — before the
// camera rolls.

// Owner/repo from an app's repo_url, or null. Same shape as routes/votes.js.
function parseRepo(url) {
  const [, owner, repo] = (url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
  return owner && repo ? { owner, repo: repo.replace(/\.git$/, '') } : null;
}

// Branch names arrive from a connected agent. Git's own rules are looser
// than this; the point is that nothing here becomes a path or a ref
// expression by accident.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
function validBranch(name) {
  return BRANCH_RE.test(name) && !name.includes('..')
    && !name.endsWith('/') && !name.endsWith('.lock');
}

const prLabel = (prNumber, title) => (title ? `PR #${prNumber}: ${title}` : `PR #${prNumber}`);

function demoModeRoutes(config) {
  const router = Router();
  const pool = getPool();

  // The one gate. Answers the app row, or null with the refusal already sent.
  //
  // Creator only, and deliberately not canAdminWrite: the containment
  // argument for a synthetic voter is that it exists on YOUR app at YOUR
  // request, and an admin override would turn that into "somebody's app".
  async function loadDemoApp(req, res, { requireDemoMode = true } = {}) {
    const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', '*');
    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return null;
    }
    if (app.self_hosted) {
      res.status(403).json({ error: 'The Homeroom platform app cannot be put in demo mode.' });
      return null;
    }
    if (req.user?.id == null || app.created_by !== req.user.id) {
      res.status(403).json({ error: 'Only the app\'s creator can use demo mode.' });
      return null;
    }
    if (requireDemoMode && !app.demo_mode) {
      res.status(403).json({
        error: 'This app is not in demo mode. Switch it on first (POST /api/apps/:slug/demo-mode).',
      });
      return null;
    }
    return app;
  }

  // The column says who the partner is; the flag says what it is. A row
  // that has lost its flag is not something anybody may act as.
  async function loadPartner(app) {
    if (!app.demo_partner_id) return null;
    const { rows } = await pool.query(
      'SELECT id, username, is_synthetic FROM users WHERE id = $1',
      [app.demo_partner_id]
    );
    return rows[0] && rows[0].is_synthetic ? rows[0] : null;
  }

  // The partner counts as a voter the way anybody does — by having used the
  // app lately (≥60s within 10 days, services/active-users.js) and, on a
  // collab-private app, by being a member. It cannot use anything, so demo
  // mode writes the standing for it: on this app only, refreshed each time
  // it acts, so the threshold stays at "both of you" however long the takes
  // go on.
  async function refreshPartnerStanding(app, partner, creatorId) {
    await pool.query(
      `INSERT INTO app_activity (app_id, user_id, seconds_spent, date)
       VALUES ($1, $2, 60, CURRENT_DATE)
       ON CONFLICT (app_id, user_id, date) DO UPDATE
         SET seconds_spent = GREATEST(app_activity.seconds_spent, 60)`,
      [app.id, partner.id]
    );
    await pool.query(
      `INSERT INTO app_collaborators (app_id, user_id, status, invited_by, accepted_at)
       VALUES ($1, $2, 'member', $3, NOW())
       ON CONFLICT (app_id, user_id) DO UPDATE SET status = 'member'`,
      [app.id, partner.id, creatorId]
    );
  }

  // Every proposal the partner has on this app, any status. Reset removes
  // all of them; switching demo mode off requires there to be none.
  async function partnerSessions(app, partner) {
    const { rows } = await pool.query(
      `SELECT id, pr_number, status FROM chat_sessions
        WHERE app_id = $1 AND user_id = $2 ORDER BY id`,
      [app.id, partner.id]
    );
    return rows;
  }

  // The partner's proposal that is open now, with the app columns
  // checkAndMerge reads off the session (routes/votes.js selects the same).
  async function openDemoSession(app, partner) {
    const { rows } = await pool.query(
      `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
              a.self_hosted AS app_self_hosted
         FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
        WHERE cs.app_id = $1 AND cs.user_id = $2
          AND cs.status IN ('active', 'promoted', 'merging')
        ORDER BY cs.id DESC LIMIT 1`,
      [app.id, partner.id]
    );
    return rows[0] || null;
  }

  // ── The switch ─────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo-mode', drainGuard, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res, { requireDemoMode: false });
      if (!app) return;
      const partner = await loadPartner(app);

      if (req.body?.enabled === false) {
        if (partner && (await partnerSessions(app, partner)).length) {
          return res.status(409).json({
            error: 'The partner still has proposals on this app. Reset demo mode first, then switch it off.',
          });
        }
        await pool.query(
          'UPDATE apps SET demo_mode = FALSE, demo_partner_id = NULL, demo_base_sha = NULL WHERE id = $1',
          [app.id]
        );
        if (partner) {
          // Its standing goes with it (rule 4 above), and so does the row: a
          // partner has no history left by now, and a synthetic account with
          // nothing to attribute is a name held for nobody.
          await pool.query('DELETE FROM users WHERE id = $1 AND is_synthetic = TRUE', [partner.id]);
        }
        log.info('demo-mode', 'Demo mode off', { slug: app.slug, userId: req.user.id });
        return res.json({ demoMode: false, partner: null, baseSha: null });
      }

      let who = partner;
      const wanted = typeof req.body?.partnerName === 'string' ? req.body.partnerName.trim() : '';
      if (who && wanted && wanted !== who.username) {
        return res.status(409).json({
          error: `This app's demo partner is @${who.username}. Switch demo mode off to choose another name.`,
        });
      }
      if (!who) {
        if (!wanted) {
          return res.status(400).json({ error: 'partnerName is required the first time demo mode is switched on.' });
        }
        const valid = usernames.validateUsername(wanted);
        if (!valid.ok) return res.status(400).json({ error: valid.error });
        const free = await usernames.checkAvailability(pool, valid.value, null);
        if (!free.available) return res.status(409).json({ error: free.error });
        // Random and discarded: nothing will ever compare equal to it, and
        // routes/auth.js refuses the row before comparing anyway.
        const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        const { rows } = await pool.query(
          `INSERT INTO users (username, password, is_admin, can_create_apps, is_synthetic)
           VALUES ($1, $2, FALSE, FALSE, TRUE)
           RETURNING id, username, is_synthetic`,
          [valid.value, hash]
        );
        who = rows[0];
      }

      // Where main stands now is where reset puts it back. Read live when
      // GitHub is there; the deploy's own record otherwise.
      let baseSha = app.main_sha || null;
      const repo = parseRepo(app.repo_url);
      if (repo && github.isEnabled()) {
        try {
          const head = await github.getRepoHead(repo.owner, repo.repo);
          if (head?.headSha) baseSha = head.headSha;
        } catch (err) {
          log.warn('demo-mode', 'Could not read the repository head; using the deployed sha', {
            slug: app.slug, err: err.message,
          });
        }
      }
      await pool.query(
        'UPDATE apps SET demo_mode = TRUE, demo_partner_id = $1, demo_base_sha = $2 WHERE id = $3',
        [who.id, baseSha, app.id]
      );
      await refreshPartnerStanding(app, who, req.user.id);
      log.info('demo-mode', 'Demo mode on', { slug: app.slug, partner: who.username, baseSha });
      res.json({ demoMode: true, partner: { id: who.id, username: who.username }, baseSha });
    } catch (err) {
      log.error('demo-mode', 'Switch failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Status: what would spoil the take ─────────────────────────────────
  router.get('/api/apps/:slug/demo', async (req, res) => {
    try {
      const app = await loadDemoApp(req, res, { requireDemoMode: false });
      if (!app) return;
      const partner = await loadPartner(app);
      const open = partner ? await openDemoSession(app, partner) : null;

      let tally = null;
      if (open) {
        const { rows } = await pool.query(
          'SELECT vote, COUNT(*)::int AS n FROM pr_votes WHERE session_id = $1 GROUP BY vote',
          [open.id]
        );
        tally = { yes: 0, no: 0 };
        for (const r of rows) if (r.vote in tally) tally[r.vote] = r.n;
      }
      const activeIds = await activeUsers.listActiveUserIds(pool, app.id);
      const activeCount = activeIds.length;
      const required = activeUsers.requiredVotes(activeCount, tally ? tally.no : 0);
      const creatorActive = await activeUsers.isUserActive(pool, app.id, req.user.id);
      const partnerActive = partner ? await activeUsers.isUserActive(pool, app.id, partner.id) : false;
      const notify = await notificationPreferences.allowsKind(pool, {
        userId: req.user.id, appId: app.id, kind: 'pr_proposed',
      });

      const reasons = [];
      if (!app.demo_mode) reasons.push('Demo mode is off.');
      if (!partner) reasons.push('There is no partner yet: switch demo mode on with a partnerName.');
      if (!notify) {
        reasons.push('"New proposals to vote on" is off for you on this app (it defaults off), so no notification would arrive. Switch it on in the app\'s notification settings.');
      }
      if (!creatorActive) {
        reasons.push('You have not used this app in the last 10 days, so you are not counted as a voter and the partner\'s yes would merge on its own. Open the app for a minute.');
      }
      if (partner && !partnerActive) {
        reasons.push('The partner is not counted as a voter; switching demo mode on again, or proposing, refreshes that.');
      }
      if (required !== 2) {
        reasons.push(`${activeCount} active voter(s) means ${required} yes vote(s) merge a proposal; the take expects 2, so the partner's yes waits on yours.`);
      }

      res.json({
        demoMode: !!app.demo_mode,
        partner: partner ? { id: partner.id, username: partner.username } : null,
        baseSha: app.demo_base_sha || null,
        mainSha: app.main_sha || null,
        activeCount,
        required,
        creatorActive,
        partnerActive,
        notifyOnNewProposals: notify,
        openProposal: open ? {
          sessionId: open.id,
          status: open.status,
          prNumber: open.pr_number || null,
          prUrl: open.pr_url || null,
          title: open.pr_title || null,
          stagingUrl: open.staging_url || null,
          votes: tally,
        } : null,
        ready: reasons.length === 0,
        reasons,
      });
    } catch (err) {
      log.error('demo-mode', 'Status failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Propose ────────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/propose', drainGuard, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) {
        return res.status(409).json({ error: 'Demo mode has no partner. Switch it on with a partnerName first.' });
      }

      const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
      if (!validBranch(branch)) {
        return res.status(400).json({ error: 'branch must name a branch on the app\'s repository.' });
      }
      const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 256) : '';
      if (!title) return res.status(400).json({ error: 'title is required.' });
      const description = typeof req.body?.description === 'string' ? req.body.description : '';
      const summary = typeof req.body?.summary === 'string' && req.body.summary.trim()
        ? req.body.summary.trim() : null;
      const testingPaths = Array.isArray(req.body?.testingPaths)
        ? req.body.testingPaths.filter((p) => typeof p === 'string' && p.trim())
          .map((p) => p.trim()).slice(0, 3)
        : [];

      const repo = parseRepo(app.repo_url);
      if (!repo || !github.isEnabled()) {
        return res.status(409).json({ error: 'GitHub is not configured for this app.' });
      }
      if (await openDemoSession(app, partner)) {
        return res.status(409).json({ error: 'A demo proposal is already open. Reset before proposing again.' });
      }

      let headSha;
      try {
        headSha = await github.getBranchSha(repo.owner, repo.repo, branch);
      } catch (err) {
        return res.status(404).json({ error: `Branch "${branch}" was not found on ${repo.owner}/${repo.repo}.` });
      }
      const pr = await github.createPR(repo.owner, repo.repo, { branch, title, body: description });
      const prNumber = pr.number;
      const prUrl = pr.html_url || null;
      // The PR is the bot's, as every connector submission's is; the PROPOSAL
      // is the partner's. It is the same split pr-import makes.
      const botLogin = await github.getBotUsername().catch(() => null);

      const { rows: inserted } = await pool.query(
        `INSERT INTO chat_sessions
           (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status,
            source, imported_pr_head_sha, imported_pr_author, imported_pr_head_repo,
            promoted_at, created_at, testing_path, testing_paths, linked_issues,
            pr_body, pr_summary_md)
         VALUES ($1, $2, $3, $4, $5, $6, 'promoted',
            'imported', $7, $8, $9,
            NOW(), NOW(), $10, $11::jsonb, '{}', $12, $13)
         RETURNING id, status`,
        [
          app.id, partner.id, branch, prNumber, prUrl, title,
          headSha, botLogin, `${repo.owner}/${repo.repo}`,
          testingPaths[0] || null, testingPaths.length ? JSON.stringify(testingPaths) : null,
          description || null, summary,
        ]
      );
      const sessionId = inserted[0].id;
      await topicAttrs.selfAssignProposal(pool, app.id, sessionId, partner);
      await refreshPartnerStanding(app, partner, req.user.id);

      const session = {
        id: sessionId, app_id: app.id, app_slug: app.slug, app_name: app.name,
        user_id: partner.id, branch_name: branch, pr_number: prNumber, pr_url: prUrl,
        pr_title: title, pr_body: description || null, pr_summary_md: summary,
        repo_url: app.repo_url, staging_url: null, source: 'imported', status: 'promoted',
        imported_pr_head_sha: headSha, imported_pr_head_repo: `${repo.owner}/${repo.repo}`,
        testing_md: null, testing_path: testingPaths[0] || null,
        testing_paths: testingPaths.length ? testingPaths : null,
      };
      // Preview + checks, exactly as an import gets them. Never throws.
      prImportSync.kickImportedChecks({ config, pool, session, app, headSha });

      const line = `${partner.username} promoted ${prLabel(prNumber, title)} for voting`;
      await ws.sendSystemMessage(pool, app.id, line, 'vote', { vote: { sessionId, prNumber } })
        .catch(() => {});
      await ws.sendSystemMessage(pool, app.id, line, 'vote', { vote: { sessionId, prNumber } },
        { type: 'session', ref: sessionId }).catch(() => {});
      ws.pushSessionUpdate({ action: 'promoted', sessionId, appSlug: app.slug });
      try {
        events.record(pool, {
          type: events.EVENT_TYPES.PR_PROMOTED,
          userId: partner.id, appId: app.id, sessionId,
          metadata: { prNumber, source: 'imported', demo: true },
        });
      } catch { /* events are best-effort */ }

      // The beat the feature exists for. Same fan-out as the promote route in
      // routes/votes.js. The partner is the proposer, so it is excluded, and
      // the creator — active, and the app's creator — is who it reaches.
      let notified = 0;
      try {
        const rows = await notifications.createPrProposedNotifications(pool, {
          appId: app.id, sessionId, proposerId: partner.id,
        });
        for (const row of rows) {
          ws.pushNotificationToUser(row.user_id, {
            type: 'notification_new',
            notification: notifications.serialize({
              ...row, app_slug: app.slug, app_name: app.name,
              pr_title: title, pr_number: prNumber, source_username: partner.username,
            }),
          });
        }
        notified = rows.length;
      } catch (err) {
        log.warn('demo-mode', 'pr_proposed fan-out failed', { sessionId, err: err.message });
      }

      log.info('demo-mode', 'Demo proposal opened', { slug: app.slug, sessionId, prNumber, notified });
      res.json({ ok: true, sessionId, prNumber, prUrl, headSha, notified });
    } catch (err) {
      log.error('demo-mode', 'Propose failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Vote ───────────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/vote', drainGuard, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) return res.status(409).json({ error: 'Demo mode has no partner.' });
      const vote = req.body?.vote === 'no' ? 'no' : 'yes';

      const session = await openDemoSession(app, partner);
      if (!session || !['promoted', 'merging'].includes(session.status)) {
        return res.status(404).json({ error: 'No demo proposal is up for a vote.' });
      }
      // The same write a person's click makes (routes/votes.js): stamped with
      // the reviewed head and the approval epoch, under the row lock. No
      // pre-vote reconciliation — the head is the platform's own and nothing
      // else writes that branch; checkAndMerge re-verifies it regardless.
      const recorded = await votes.recordVote({
        pool, session, userId: partner.id, vote,
        headSha: reviewedHeadForSession(session), revisionEnforced: true,
      });
      if ((recorded.rowCount || 0) === 0) {
        return res.status(409).json({ error: 'The proposal is no longer open for votes.' });
      }
      const label = prLabel(session.pr_number || session.id, session.pr_title);
      await ws.sendSystemMessage(pool, app.id, `${partner.username} voted ${vote} on ${label}`, 'vote',
        { vote: { sessionId: session.id, prNumber: session.pr_number || null } },
        { type: 'session', ref: session.id }).catch(() => {});
      ws.pushVoteUpdate({ sessionId: session.id, appSlug: app.slug, merged: false });
      try {
        events.record(pool, {
          type: events.EVENT_TYPES.PR_VOTE_CAST,
          userId: partner.id, appId: app.id, sessionId: session.id, metadata: { vote, demo: true },
        });
      } catch { /* best-effort */ }
      // No "somebody voted on your proposal" notification: the author IS the
      // partner, and a notification to an account that cannot sign in is a
      // row nobody reads.
      res.json({ ok: true, sessionId: session.id, vote });

      votes.checkAndMerge(config, pool, session)
        .then((result) => {
          if (result?.merged) ws.pushVoteUpdate({ sessionId: session.id, appSlug: app.slug, merged: true });
        })
        .catch((err) => log.error('demo-mode', 'Background merge failed', {
          sessionId: session.id, err: err.message,
        }));
    } catch (err) {
      log.error('demo-mode', 'Vote failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Reset ──────────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/reset', drainGuard, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) return res.status(409).json({ error: 'Demo mode has no partner.' });
      const repo = parseRepo(app.repo_url);
      const githubUp = !!(repo && github.isEnabled());

      const sessions = await partnerSessions(app, partner);
      for (const s of sessions) {
        await sessionLifecycle.teardownStagingForSession({ pool, sessionId: s.id, reason: 'demo-reset' })
          .catch((err) => log.warn('demo-mode', 'Preview teardown failed', { sessionId: s.id, err: err.message }));
        if (githubUp && s.pr_number && s.status !== 'merged') {
          await github.closePR(repo.owner, repo.repo, s.pr_number)
            .catch((err) => log.warn('demo-mode', 'Closing the PR failed', { pr: s.pr_number, err: err.message }));
        }
      }
      const ids = sessions.map((s) => s.id);
      if (ids.length) {
        // pr_votes, notifications (the creator's pr_proposed included),
        // events and the preview record all cascade from the session.
        await pool.query('DELETE FROM chat_sessions WHERE id = ANY($1::int[])', [ids]);
      }

      let main = null;
      if (githubUp && app.demo_base_sha) {
        const moved = await github.forceBranchToSha(repo.owner, repo.repo, 'main', app.demo_base_sha);
        main = { from: moved.previousSha, to: moved.sha, moved: !!moved.updated };
      }
      await refreshPartnerStanding(app, partner, req.user.id);

      // Production follows main. Fire-and-forget, as the redeploy route in
      // routes/apps.js does; a failure lands on the deploy-status broadcast.
      let redeploy = 'skipped';
      if (main && main.moved) {
        redeploy = 'started';
        staging.rebuildProduction(config, app)
          .then(async ({ containerId, sha }) => {
            await pool.query(
              `UPDATE apps SET container_id = $1, main_sha = $2, status = 'running',
                               last_deploy_at = NOW()
               WHERE id = $3`,
              [containerId, sha || null, app.id]
            );
          })
          .catch((err) => log.warn('demo-mode', 'Rebuild after reset failed', { slug: app.slug, err: err.message }));
      }
      log.info('demo-mode', 'Demo reset', { slug: app.slug, removed: ids.length, main, redeploy });
      res.json({ ok: true, sessionsRemoved: ids.length, main, redeploy });
    } catch (err) {
      log.error('demo-mode', 'Reset failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { demoModeRoutes, parseRepo, validBranch };
