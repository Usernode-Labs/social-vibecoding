const { Router } = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { getPool } = require('../db/pool');
const log = require('../services/logger');
const github = require('../services/github');
const ws = require('../services/ws');
const notificationPreferences = require('../services/notification-preferences');
const activeUsers = require('../services/active-users');
const appAccess = require('../services/app-access');
const events = require('../services/events');
const usernames = require('../services/usernames');
const appManifest = require('../services/app-manifest');
const governanceService = require('../services/governance');
const demo = require('../services/demo-operation');
const platformOperations = require('../services/platform-operations');
const flows = require('../services/git-host-flows');
const { reviewedHeadForSession } = require('../services/pr-vote-revision');
const { drainGuard } = require('../services/lifecycle');
const votes = require('./votes');
const { sameOriginBrowserOnly } = require('../middleware/same-site-browser');
const repoRef = require('../services/repo-ref');

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
//      its creator AND a full platform admin. Two fences, not one: the
//      creator fence keeps this off anybody else's app; the admin fence
//      keeps it a platform-people feature rather than something every
//      creator holds over an app other people use — the partner's yes
//      counts like a person's, and on a small shared app creator plus
//      partner reach the unopposed threshold. Never admin INSTEAD of
//      creator: that would be the override that acts on somebody else's
//      app. Demo mode is a thing you do to your own app.
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
// already on the app's repository, or from a patch it applies there itself
// (the repository is the platform's own; the creator cannot push to it), as
// the platform's own bot — the same authorship every connector submission
// has — and files it as an imported
// proposal owned by the partner, already promoted. Imported is the right
// source: the preview, checks, head-sync and merge machinery all key off it
// (services/pr-import-sync.js, evaluateMergeGate) and none of it needs a
// dev-chat worker. Then it does the one thing pr-import's own straight-to-
// vote path does not: the pr_proposed fan-out, which is the notification the
// viewer is waiting for.
//
// A take has two cues, not one, when the operator wants them apart. With
// `hold: true` demo/propose files the same proposal as an UNSHARED
// in-progress row — status 'active', shared_at NULL — so the pull request
// opens and the preview and checks build exactly as above, but nothing is
// announced and nothing lists it: the In-progress area shows shared rows
// only, the vote list shows promoted ones, and the build narrates into the
// proposal's own thread, which nothing can open yet. demo/promote is the
// second cue, and it is the promotion routes/votes.js performs for a
// person's in-progress work — status 'promoted', the "promoted … for
// voting" lines, the event, the pr_proposed fan-out — with the partner's
// vote cast first when asked, so the card already reads "voted yes" when
// the notification is tapped. By then the preview is minutes old, which is
// the point: the beat the camera waits for is the notification, not a
// build.
//
// ── The approvals rule ─────────────────────────────────────────────────
//
// Switching demo mode on also puts the app into the "at least N approvals"
// mode (services/governance.js), N = 2 by default. Under the DEFAULT
// strategy a two-voter app whose proposal has one yes arms the
// lazy-consensus clock, and the card reads "Goes live in ~3d · 1/2" until
// the second vote lands. That is correct, and it is unrecordable: the beat
// on camera is "she has approved it, it is waiting on me", and what the
// screen says is a three-day countdown. In approvals mode the same moment
// reads "1 of 2 approvals", there is no clock at all, and the second yes
// still merges it immediately. Nothing about the vote changes: the same
// votes are cast, counted and gated.
//
// It is a GOVERNANCE column, so it is put back: the previous value is
// snapshotted into demo_prev_approvals on the way in and restored on the
// way out, and the app's settings dialog says the rule is in force while
// demo mode is on.
//
// demo/vote records the partner's vote through recordVote and asks the
// app's merge queue (platform.wantMerge), exactly as routes/votes.js does for a person.
// demo/reset tears the partner's proposals down, held ones included, puts
// main back to the commit demo mode was switched on at, and rebuilds
// production. Both write to the app's repository, so a conductor makes
// those writes (services/demo-operation.js `demo.propose` and
// `demo.reset`), running this file's fences again first: each route checks
// what it can, asks, and answers what the conductor answers. GET demo lists
// what would silently spoil a take — the notification preference that
// defaults off, a creator who has not used the app lately — before the
// camera rolls, and says whether a held proposal's preview has finished
// building.

// Owner/repo from an app's repo_url, or null. Same shape as routes/votes.js.
function parseRepo(url) {
  return repoRef.ownerRepo(url);
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
  // Creator AND full platform admin — rule 2 above. canAdminWrite is
  // required on top of the creator check, never accepted in place of it:
  // the containment argument for a synthetic voter is that it exists on
  // YOUR app at YOUR request, and an admin override would turn that into
  // "somebody's app".
  async function loadDemoApp(req, res, { requireDemoMode = true } = {}) {
    const app = await appAccess.getAppForUser(pool, req.params.slug, req.user, 'view', '*');
    if (!app) {
      res.status(404).json({ error: 'App not found' });
      return null;
    }
    // The same fences the conductor runs again (services/demo-operation.js).
    const fenced = demo.fenceOf(app, req.user, { requireDemoMode });
    if (fenced) {
      res.status(fenced.status).json({ error: fenced.error });
      return null;
    }
    return app;
  }

  // The partner and its standing (services/demo-operation.js says each).
  const loadPartner = (app) => demo.loadPartner(pool, app);
  const refreshPartnerStanding = (app, partner, creatorId) => demo.refreshPartnerStanding(pool, app, partner, creatorId);

  // The approvals rule a switch-on asks for: 2 unless told otherwise, and
  // an explicit null keeps the app on its own (timed) strategy for a take
  // that wants the countdown on camera. Answers { ok, value } or an error.
  function readApprovals(body) {
    if (!body || !('approvals' in body) || body.approvals === undefined) return { ok: true, value: 2 };
    if (body.approvals === null) return { ok: true, value: null };
    const n = Number(body.approvals);
    if (!Number.isInteger(n) || n < 1 || n > appManifest.MAX_APPROVALS_REQUIRED) {
      return { ok: false, error: `approvals must be a whole number between 1 and ${appManifest.MAX_APPROVALS_REQUIRED}, or null to leave the app's own rule alone.` };
    }
    return { ok: true, value: n };
  }

  const partnerSessions = (app, partner) => demo.partnerSessions(pool, app, partner);
  const openDemoSession = (app, partner) => demo.openDemoSession(pool, app, partner);

  // ── What a promotion says, whom it reaches, and the partner's vote ──────
  //
  // Shared by demo/propose (straight to the vote, on the conductor) and
  // demo/promote (a held proposal, on cue): services/demo-operation.js
  // promoteAsPartner, the promotion routes/votes.js performs for a person.
  const promoteAsPartner = demo.promoteAsPartner;

  // The partner's vote: the same write a person's click makes
  // (routes/votes.js), stamped with the reviewed head and the approval
  // epoch, under the row lock. No pre-vote reconciliation — the head is the
  // platform's own and nothing else writes that branch; evaluateMergeGate
  // re-verifies it regardless. True when it counted.
  //
  // No "somebody voted on your proposal" notification: the author IS the
  // partner, and a notification to an account that cannot sign in is a row
  // nobody reads.
  async function castPartnerVote({ app, partner, session, vote }) {
    const recorded = await votes.recordVote({
      pool, session, userId: partner.id, vote,
      headSha: reviewedHeadForSession(session), revisionEnforced: true,
    });
    if ((recorded.rowCount || 0) === 0) return false;
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
    return true;
  }

  // After a vote, the merge check — off the request, as routes/votes.js
  // runs it for a person's vote.
  function mergeCheckAfterVote(app, session) {
    void ws;
    require('../workflow/platform.ts').wantMerge({ appId: app.id, sessionId: session.id, reason: 'demo-vote' })
      .catch((err) => log.error('demo-mode', 'Background merge failed', {
        sessionId: session.id, err: err.message,
      }));
  }

  // ── The switch ─────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo-mode', drainGuard, sameOriginBrowserOnly, async (req, res) => {
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
        // The approvals rule goes back to whatever it was. Guarded on
        // demo_mode so switching off an app that is already off cannot read
        // an empty snapshot as "the default strategy" and clear a real
        // setting.
        const { rows: restored } = await pool.query(
          `UPDATE apps
              SET demo_mode = FALSE, demo_partner_id = NULL, demo_base_sha = NULL,
                  approvals_required = CASE WHEN demo_mode THEN demo_prev_approvals ELSE approvals_required END,
                  demo_prev_approvals = NULL
            WHERE id = $1
        RETURNING approvals_required`,
          [app.id]
        );
        governanceService.invalidateGovernance(app.id);
        if (partner) {
          // Its standing goes with it (rule 4 above), and so does the row: a
          // partner has no history left by now, and a synthetic account with
          // nothing to attribute is a name held for nobody.
          await pool.query('DELETE FROM users WHERE id = $1 AND is_synthetic = TRUE', [partner.id]);
        }
        const back = restored[0] ? restored[0].approvals_required : null;
        log.info('demo-mode', 'Demo mode off', { slug: app.slug, userId: req.user.id, approvalsRequired: back });
        return res.json({ demoMode: false, partner: null, baseSha: null, approvalsRequired: back });
      }

      const approvals = readApprovals(req.body);
      if (!approvals.ok) return res.status(400).json({ error: approvals.error });

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
      // The snapshot is taken on the way IN and only then: switching on an
      // app that is already on must not overwrite it with demo mode's own
      // value, which would make the way out a no-op.
      await pool.query(
        `UPDATE apps
            SET demo_mode = TRUE, demo_partner_id = $1, demo_base_sha = $2,
                demo_prev_approvals = CASE WHEN demo_mode THEN demo_prev_approvals ELSE approvals_required END,
                approvals_required = $4
          WHERE id = $3`,
        [who.id, baseSha, app.id, approvals.value]
      );
      governanceService.invalidateGovernance(app.id);
      await refreshPartnerStanding(app, who, req.user.id);
      log.info('demo-mode', 'Demo mode on', {
        slug: app.slug, partner: who.username, baseSha, approvalsRequired: approvals.value,
      });
      res.json({
        demoMode: true, partner: { id: who.id, username: who.username }, baseSha,
        approvalsRequired: approvals.value,
      });
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
      // Which rule decides the threshold. In approvals mode it is the number
      // itself, and how lately anybody used the app does not enter into it.
      const gov = await governanceService.getGovernance(pool, app.id);
      const approvalsRequired = gov.approvalsRequired;
      const required = approvalsRequired != null
        ? approvalsRequired
        : activeUsers.requiredVotes(activeCount, tally ? tally.no : 0);
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
      if (approvalsRequired == null) {
        // Only the default strategy counts voters by how lately they used
        // the app; approvals mode counts votes.
        if (!creatorActive) {
          reasons.push('You have not used this app in the last 10 days, so you are not counted as a voter and the partner\'s yes would merge on its own. Open the app for a minute.');
        }
        if (partner && !partnerActive) {
          reasons.push('The partner is not counted as a voter; switching demo mode on again, or proposing, refreshes that.');
        }
        reasons.push('This app is on the default strategy, so a proposal with one yes counts down a lazy-consensus window and the card reads "Goes live in ~3d" rather than a tally. Switch demo mode on with approvals: 2 for the "1 of 2 approvals" card.');
      }
      if (required !== 2) {
        reasons.push(approvalsRequired != null
          ? `This app merges a proposal on ${required} approval(s); the take expects 2, so the partner's yes waits on yours.`
          : `${activeCount} active voter(s) means ${required} yes vote(s) merge a proposal; the take expects 2, so the partner's yes waits on yours.`);
      }

      res.json({
        demoMode: !!app.demo_mode,
        partner: partner ? { id: partner.id, username: partner.username } : null,
        baseSha: app.demo_base_sha || null,
        // null means the app's own (timed) strategy, where a single yes
        // shows a countdown rather than a tally.
        approvalsRequired: approvalsRequired ?? null,
        mainSha: app.main_sha || null,
        activeCount,
        required,
        creatorActive,
        partnerActive,
        notifyOnNewProposals: notify,
        openProposal: open ? {
          sessionId: open.id,
          status: open.status,
          // Held: filed, building, announced to nobody yet (demo/promote).
          held: open.status === 'active',
          prNumber: open.pr_number || null,
          prUrl: open.pr_url || null,
          title: open.pr_title || null,
          stagingUrl: open.staging_url || null,
          // The checks verdict on the preview: 'pending' while it builds,
          // 'passing' once it is the preview a vote would open.
          checkState: open.check_state || null,
          previewReady: !!open.staging_url,
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

      const branchIn = typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
      const patch = typeof req.body?.patch === 'string' ? req.body.patch : '';
      if (branchIn && patch.trim()) {
        return res.status(400).json({ error: 'Pass either branch or patch, not both.' });
      }
      if (!branchIn && !patch.trim()) {
        return res.status(400).json({
          error: 'Pass branch (a branch already on the app\'s repository) or patch (the change as git diff or git format-patch output).',
        });
      }
      if (branchIn && !validBranch(branchIn)) {
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
      // Held: filed as the partner's unshared in-progress work, so the pull
      // request opens and the preview builds while nothing is announced;
      // demo/promote is the cue that puts it up for the vote.
      const hold = req.body?.hold === true;

      // The rest is the conductor's (services/demo-operation.js
      // `demo.propose`): the code host's being there, one demo proposal at
      // a time, the patch's push, the pull request and the proposal. The
      // patch and the texts travel as the request's large input.
      const out = await platformOperations.request({
        op: 'demo.propose', appId: app.id, userId: req.user.id,
        input: { branch: branchIn || null, title, hold },
        payload: { ...(patch.trim() ? flows.patchPayload(patch) : {}), description, summary, testingPaths },
      });
      if (!out.ok) return flows.refused(res, out);
      res.json({ ok: true, ...flows.answered(out) });
    } catch (err) {
      log.error('demo-mode', 'Propose failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Promote: the second cue ────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/promote', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) return res.status(409).json({ error: 'Demo mode has no partner.' });
      const vote = req.body?.vote === 'yes' || req.body?.vote === 'no' ? req.body.vote : null;

      const session = await openDemoSession(app, partner);
      if (!session) {
        return res.status(404).json({ error: 'No demo proposal is held. Propose one with hold first.' });
      }
      if (session.status !== 'active') {
        return res.status(409).json({ error: 'The demo proposal is already up for the vote.' });
      }

      // What goes up for the vote is what was proposed. The promote route in
      // routes/votes.js re-reads the pull request before it opens voting and
      // fails closed when it cannot; so does this. Nothing else writes the
      // branch, so a moved head is a take that needs a reset, not a rebuild.
      const repo = parseRepo(app.repo_url);
      if (repo && github.isEnabled() && session.pr_number) {
        let pr;
        try {
          pr = await github.getPR(repo.owner, repo.repo, session.pr_number);
        } catch (err) {
          log.warn('demo-mode', 'Could not read the pull request before promoting', {
            sessionId: session.id, err: err.message,
          });
          return res.status(503).json({ error: 'GitHub could not verify the pull request. Try again shortly.' });
        }
        if (pr?.merged) {
          return res.status(409).json({
            error: `PR #${session.pr_number} was already merged on GitHub, so there is nothing to vote on. Reset before the next take.`,
          });
        }
        if (pr?.state === 'closed') {
          return res.status(409).json({ error: `PR #${session.pr_number} is closed on GitHub. Reset and propose again.` });
        }
        const head = String(pr?.head?.sha || '').toLowerCase();
        const proposedAt = String(session.imported_pr_head_sha || '').toLowerCase();
        if (head && proposedAt && head !== proposedAt) {
          return res.status(409).json({ error: 'The branch moved since it was proposed. Reset and propose again.' });
        }
      }

      // Up for the vote the way every proposal goes up (the proposal
      // machine: the line, the promoted event, the vote requests), as the
      // partner's. Two cues racing cannot promote twice.
      const promoted = await promoteAsPartner({ app, partner, session });
      if (promoted.status !== 200) return res.status(promoted.status).json(promoted.body);
      session.status = 'promoted';
      await refreshPartnerStanding(app, partner, req.user.id);

      let voted = null;
      if (vote && await castPartnerVote({ app, partner, session, vote })) voted = vote;
      const notified = null;

      log.info('demo-mode', 'Demo proposal promoted', {
        slug: app.slug, sessionId: session.id, prNumber: session.pr_number, voted, notified,
      });
      res.json({ ok: true, sessionId: session.id, prNumber: session.pr_number || null, voted, notified });
      if (voted) mergeCheckAfterVote(app, session);
    } catch (err) {
      log.error('demo-mode', 'Promote failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Vote ───────────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/vote', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) return res.status(409).json({ error: 'Demo mode has no partner.' });
      const vote = req.body?.vote === 'no' ? 'no' : 'yes';

      const session = await openDemoSession(app, partner);
      if (session && session.status === 'active') {
        return res.status(409).json({
          error: 'The demo proposal is held, not yet up for the vote. Promote it first (POST /api/apps/:slug/demo/promote), which can cast this vote as well.',
        });
      }
      if (!session || !['promoted', 'merging'].includes(session.status)) {
        return res.status(404).json({ error: 'No demo proposal is up for a vote.' });
      }
      if (!await castPartnerVote({ app, partner, session, vote })) {
        return res.status(409).json({ error: 'The proposal is no longer open for votes.' });
      }
      res.json({ ok: true, sessionId: session.id, vote });
      mergeCheckAfterVote(app, session);
    } catch (err) {
      log.error('demo-mode', 'Vote failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Reset ──────────────────────────────────────────────────────────────
  router.post('/api/apps/:slug/demo/reset', drainGuard, sameOriginBrowserOnly, async (req, res) => {
    try {
      const app = await loadDemoApp(req, res);
      if (!app) return;
      const partner = await loadPartner(app);
      if (!partner) return res.status(409).json({ error: 'Demo mode has no partner.' });

      const sessions = await partnerSessions(app, partner);
      // For good, before the rows go, and first: the preview machine stops a
      // build still going and retires what serves (an idle retirement would
      // wait for the build). Each request must have retired it before any
      // row is deleted: a preview the machine does not hold yet is adopted
      // from its row when the request is applied, and one still pending,
      // refused or faulted would leave its resources behind. Otherwise the
      // reset stops here, with nothing changed, and can be asked again.
      const previewWorkflow = require('../services/preview-workflow');
      for (const s of sessions) {
        const out = await previewWorkflow.retire({
          session: { id: s.id, app_id: app.id }, reason: 'demo-reset', terminal: true, waitMs: 30_000,
        }).catch((err) => ({ retired: false, reason: err.message }));
        if (!out.retired) {
          log.warn('demo-mode', 'Preview not retired; reset stopped before deleting anything', {
            sessionId: s.id, reason: out.reason || out.status || null,
          });
          return res.status(409).json({ error: 'A preview is still being retired. Reset again in a minute.', reason: 'preview_retiring' });
        }
      }
      // The rest is the conductor's (services/demo-operation.js
      // `demo.reset`): the pull requests closed, the rows deleted, main put
      // back and production asked to follow, for the proposals retired here.
      const out = await platformOperations.request({
        op: 'demo.reset', appId: app.id, userId: req.user.id, input: { sessionIds: sessions.map((s) => s.id) },
      });
      if (!out.ok) return flows.refused(res, out);
      res.json({ ok: true, ...flows.answered(out) });
    } catch (err) {
      log.error('demo-mode', 'Reset failed', { slug: req.params.slug, message: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { demoModeRoutes, parseRepo, validBranch };
