'use strict';

// `demo.propose` and `demo.reset`, platform operations
// (services/platform-operations.js, "git-host flows"): demo mode's writes to
// the demo app's repository (routes/demo-mode.js says what demo mode is and
// why it is fenced the way it is), made on a conductor.
//
//   demo.propose   the partner's proposal: a patch applied at main's live
//                  head and pushed as the bot (or a branch already there),
//                  its pull request, the imported proposal filed as the
//                  partner's, its preview and checks, and (unless held) its
//                  promote. Input: { branch, title, hold }; payload:
//                  { patchB64?, description, summary, testingPaths }.
//   demo.reset     the partner's proposals taken down: their pull requests
//                  closed, their rows deleted, main forced back to the
//                  commit demo mode was switched on at, production asked to
//                  follow. Input: { sessionIds }, the proposals whose
//                  previews the route retired first (a reset stops before
//                  anything changes while one is still being retired).
//
// POST /api/apps/:slug/demo/propose and /demo/reset keep their doors and
// checks and ask for these. The conductor runs the route's fences again on
// every attempt before anything is written (demo mode on, the app's creator
// AND a full admin, never the platform's own app, a partner that is still
// synthetic), and for a proposal the code host and the one open demo
// proposal at a time (this request's own, once it has one, is no other).
// Each write is a step, so a retry pushes nothing twice, opens no second
// pull request and moves main once. Their refusals are the routes' answers.
//
// The partner's helpers below are the route's too.

const log = require('./logger');
const github = require('./github');
const appAccess = require('./app-access');
const topicAttrs = require('./topic-attributes');
const prImportSync = require('./pr-import-sync');
const summaryFreshness = require('./summary-freshness');
const externalAgentPatch = require('./external-agent-patch');
const repoRef = require('./repo-ref');
const flows = require('./git-host-flows');

// ── The fences and the partner (routes/demo-mode.js, "Containment") ─────

// Rule 2 and 3 of the containment, on an app the caller can see: the
// refusal, or null.
function fenceOf(app, user, { requireDemoMode = true } = {}) {
  if (app.self_hosted) return { status: 403, error: 'The Homeroom platform app cannot be put in demo mode.' };
  if (user?.id == null || app.created_by !== user.id) return { status: 403, error: 'Only the app\'s creator can use demo mode.' };
  if (!user.canAdminWrite) return { status: 403, error: 'Demo mode is for an app\'s creator who is also a full platform admin.' };
  if (requireDemoMode && !app.demo_mode) {
    return { status: 403, error: 'This app is not in demo mode. Switch it on first (POST /api/apps/:slug/demo-mode).' };
  }
  return null;
}

// The column says who the partner is; the flag says what it is. A row
// that has lost its flag is not something anybody may act as.
async function loadPartner(pool, app) {
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
async function refreshPartnerStanding(pool, app, partner, creatorId) {
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
async function partnerSessions(pool, app, partner) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, status FROM chat_sessions
      WHERE app_id = $1 AND user_id = $2 ORDER BY id`,
    [app.id, partner.id]
  );
  return rows;
}

// The partner's proposal that is open now, with the app columns
// evaluateMergeGate reads off the session (routes/votes.js selects the same).
async function openDemoSession(pool, app, partner) {
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

// Up for the vote, as the partner's: the proposal machine reads the pull
// request (refusing one merged or closed), puts it up and says so (the
// line, the promoted event, the vote requests to the creator, the partner
// being the proposer), as the promote route in routes/votes.js does.
async function promoteAsPartner({ app, partner, session }) {
  return require('../workflow/platform.ts').promoteProposal({
    sessionId: session.id, appId: app.id, userId: partner.id, username: partner.username, from: 'active',
    cap: 1000, pr: null, source: { kind: 'system', name: 'demo' },
  });
}

// ── On the conductor ─────────────────────────────────────────────────────

const NO_PARTNER = new Map([
  ['demo.propose', 'Demo mode has no partner. Switch it on with a partnerName first.'],
  ['demo.reset', 'Demo mode has no partner.'],
]);

// The app as its route's gate reads it (appAccess.getAppForUser by its slug,
// so a slug that now names another app is that app's, not this one's).
async function loadApp(pool, request, user) {
  const { rows: [row] } = await pool.query('SELECT * FROM apps WHERE id = $1', [request.appId]);
  if (!row) return null;
  const app = await appAccess.getAppForUser(pool, row.slug, user, 'view', '*');
  return app && app.id === request.appId ? app : null;
}

async function authorize({ pool }, request, user, { steps = null } = {}) {
  if (!NO_PARTNER.has(request.op)) throw Object.assign(new Error(`Unknown demo operation ${request.op}`), { permanent: true });
  if (steps?.has('result')) return null;
  const app = await loadApp(pool, request, user);
  if (!app) return { status: 404, body: { error: 'App not found' } };
  const fenced = fenceOf(app, user);
  if (fenced) return { status: fenced.status, body: { error: fenced.error } };
  const partner = await loadPartner(pool, app);
  if (!partner) return { status: 409, body: { error: NO_PARTNER.get(request.op) } };
  if (request.op === 'demo.propose') {
    if (!repoRef.ownerRepo(app.repo_url) || !github.isEnabled()) {
      return { status: 409, body: { error: 'GitHub is not configured for this app.' } };
    }
    const open = await openDemoSession(pool, app, partner);
    const ownPr = steps?.get?.('pr')?.number;
    const mine = open && (open.id === steps?.get?.('session') || (ownPr != null && Number(open.pr_number) === Number(ownPr)));
    if (open && !mine) return { status: 409, body: { error: 'A demo proposal is already open. Reset before proposing again.' } };
  }
  return null;
}

const failed = (status, body) => ({ ok: false, status, body });

async function propose({ config, pool }, request, user, steps) {
  const app = await loadApp(pool, request, user);
  const partner = app && await loadPartner(pool, app);
  if (!partner) throw Object.assign(new Error('The demo app or its partner is gone'), { permanent: true });
  const repo = repoRef.ownerRepo(app.repo_url);
  const given = await require('./platform-operations').inputOf(pool, request.requestId);
  if (!given) return failed(409, { error: 'This proposal has expired. Propose it again.' });
  const patch = flows.patchOf(given) || '';
  const description = typeof given.description === 'string' ? given.description : '';
  const summary = typeof given.summary === 'string' ? given.summary : null;
  const testingPaths = Array.isArray(given.testingPaths) ? given.testingPaths : [];
  const { title, hold } = request.input;

  let branch = request.input.branch || '';
  let headSha;
  // Only a branch this request created is this request's to remove.
  let discardBranch = async () => {};
  if (patch.trim()) {
    // The app's repository is the platform's own and its creator cannot
    // push there, so a change usually arrives as a patch, applied at main's
    // current head and pushed as the bot. Same path, same bounds as
    // submit_work's patch shape (services/external-agent-patch.js):
    // size-capped before git runs, .github/** refused, every path enumerated
    // first. Applied at the LIVE head rather than the recorded base: after a
    // reset they are the same commit, and between takes that did not reset,
    // the live head is the one a PR can merge into. Read once.
    const baseSha = await steps.once('base', async () => {
      try {
        const live = await github.getRepoHead(repo.owner, repo.repo);
        if (live?.headSha) return live.headSha;
      } catch (err) {
        log.warn('demo-mode', 'Could not read the repository head; applying at the deployed sha', { slug: app.slug, err: err.message });
      }
      return app.main_sha || null;
    });
    const applied = await flows.appliedStep(steps, 'applied', (attempt) => externalAgentPatch.applyPatch({
      ...attempt,
      owner: repo.owner, repo: repo.repo, patch, baseSha, userId: partner.id, taskId: `demo-${app.id}`,
    }), { owner: repo.owner, repo: repo.repo });
    if (!applied.ok) {
      const status = applied.code === 'patch_too_large' ? 413
        : applied.code === 'platform_unavailable' ? 503
          : applied.code === 'patch_did_not_apply' ? 409 : 400;
      return failed(status, { error: applied.message || 'The patch could not be applied.', code: applied.code || null });
    }
    branch = applied.branch;
    headSha = applied.headSha;
    discardBranch = applied.cleanup;
  } else {
    const found = await steps.once('head', async () => {
      try {
        return { sha: await github.getBranchSha(repo.owner, repo.repo, branch) };
      } catch {
        return { missing: true };
      }
    });
    if (found.missing) return failed(404, { error: `Branch "${branch}" was not found on ${repo.owner}/${repo.repo}.` });
    headSha = found.sha;
  }

  let pr;
  try {
    pr = await steps.once('pr', async () => {
      const made = await flows.openPr(github, repo.owner, repo.repo, { branch, title, body: description });
      return { number: made.number, html_url: made.html_url || null };
    });
  } catch (err) {
    if (flows.stopped(steps, err) || !flows.permanentPrRefusal(err)) throw err;
    // A branch this request pushed for a PR that never opened is litter;
    // applyPatch hands back the broom for exactly this.
    await discardBranch().catch(() => {});
    log.error('demo-mode', 'Opening the PR failed', { slug: app.slug, branch, err: err.message });
    return failed(502, { error: 'GitHub did not open the pull request. Nothing was proposed.' });
  }
  const prNumber = pr.number;
  const prUrl = pr.html_url || null;
  // The PR is the bot's, as every connector submission's is; the PROPOSAL
  // is the partner's. It is the same split pr-import makes.
  const botLogin = await steps.once('bot', () => github.getBotUsername().catch(() => null));

  const sessionId = await steps.once('session', async () => {
    // This request's own row, when an earlier attempt's insert committed
    // and its step was not kept.
    const { rows: [mine] } = await pool.query(
      'SELECT id FROM chat_sessions WHERE app_id = $1 AND user_id = $2 AND pr_number = $3 ORDER BY id DESC LIMIT 1',
      [app.id, partner.id, prNumber]
    );
    if (mine) return mine.id;
    const { rows: inserted } = await pool.query(
      `INSERT INTO chat_sessions
         (app_id, user_id, branch_name, pr_number, pr_url, pr_title, status,
          source, imported_pr_head_sha, imported_pr_author, imported_pr_head_repo,
          promoted_at, created_at, testing_path, testing_paths, linked_issues,
          pr_body, pr_summary_md, pr_summary_source, pr_summary_source_head_sha,
          pr_summary_source_body_hash, pr_summary_applied_version)
       VALUES ($1, $2, $3, $4, $5, $6, $14::text,
          'imported', $7::text, $8, $9,
          CASE WHEN $14::text = 'promoted' THEN NOW() END, NOW(), $10, $11::jsonb, '{}', $12, $13,
          CASE WHEN $13::text IS NULL THEN NULL ELSE 'author' END,
          CASE WHEN $13::text IS NULL THEN NULL ELSE $7::text END,
          CASE WHEN $13::text IS NULL THEN NULL ELSE $15 END,
          CASE WHEN $13::text IS NULL THEN NULL ELSE 0 END)
       RETURNING id, status`,
      [
        app.id, partner.id, branch, prNumber, prUrl, title,
        headSha, botLogin, `${repo.owner}/${repo.repo}`,
        testingPaths[0] || null, testingPaths.length ? JSON.stringify(testingPaths) : null,
        description || null, summary,
        'active',
        summaryFreshness.bodyHash(description || null),
      ]
    );
    return inserted[0].id;
  });
  await steps.once('topic', () => topicAttrs.selfAssignProposal(pool, app.id, sessionId, partner).then(() => true));
  await refreshPartnerStanding(pool, app, partner, user.id);

  const session = {
    id: sessionId, app_id: app.id, app_slug: app.slug, app_name: app.name,
    user_id: partner.id, branch_name: branch, pr_number: prNumber, pr_url: prUrl,
    pr_title: title, pr_body: description || null, pr_summary_md: summary,
    repo_url: app.repo_url, staging_url: null, source: 'imported',
    status: 'active',
    imported_pr_head_sha: headSha, imported_pr_head_repo: `${repo.owner}/${repo.repo}`,
    testing_md: null, testing_path: testingPaths[0] || null,
    testing_paths: testingPaths.length ? testingPaths : null,
  };
  // Preview + checks, exactly as an import gets them. Never throws.
  await steps.once('checks', () => { prImportSync.kickImportedChecks({ config, pool, session, app, headSha }); return true; });

  if (hold) {
    // Nothing said and nothing listed. The build narrates into the
    // proposal's thread (pr-import-sync.postProposalNote), which nothing
    // can open until demo/promote.
    log.info('demo-mode', 'Demo proposal held', { slug: app.slug, sessionId, prNumber });
  } else {
    const promoted = await steps.once('promote', async () => {
      // An earlier attempt's promote that went through without its step
      // being kept: the proposal is up already.
      if (steps.resumed) {
        const { rows: [now] } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [sessionId]);
        if (now && now.status !== 'active') return { status: 200, body: { ok: true } };
      }
      return promoteAsPartner({ app, partner, session });
    });
    if (promoted.status !== 200 && promoted.status !== 202) return failed(promoted.status, promoted.body);
    log.info('demo-mode', 'Demo proposal opened', { slug: app.slug, sessionId, prNumber });
  }
  return { sessionId, prNumber, prUrl, headSha, held: !!hold, notified: null };
}

async function reset({ pool }, request, user, steps) {
  const app = await loadApp(pool, request, user);
  const partner = app && await loadPartner(pool, app);
  if (!partner) throw Object.assign(new Error('The demo app or its partner is gone'), { permanent: true });
  const repo = repoRef.ownerRepo(app.repo_url);
  const githubUp = !!(repo && github.isEnabled());
  // The partner's proposals whose previews the route retired, as they stand.
  const asked = new Set((request.input.sessionIds || []).map(Number));
  const sessions = (await partnerSessions(pool, app, partner)).filter((s) => asked.has(Number(s.id)));
  await steps.once('closed', async () => {
    for (const s of sessions) {
      if (githubUp && s.pr_number && s.status !== 'merged') {
        await github.closePR(repo.owner, repo.repo, s.pr_number)
          .catch((err) => log.warn('demo-mode', 'Closing the PR failed', { pr: s.pr_number, err: err.message }));
      }
    }
    return true;
  });
  const removed = await steps.once('deleted', async () => {
    const ids = sessions.map((s) => s.id);
    // pr_votes, notifications (the creator's pr_proposed included), events
    // and the preview record all cascade from the session.
    if (ids.length) await pool.query('DELETE FROM chat_sessions WHERE id = ANY($1::int[])', [ids]);
    return ids.length;
  });

  let planned = await steps.once('main-target', async () => {
    if (!githubUp || !app.demo_base_sha) return null;
    const from = await github.getBranchSha(repo.owner, repo.repo, 'main');
    return { from, to: app.demo_base_sha, moved: from !== app.demo_base_sha };
  });
  const target = steps.get('main') || planned;
  if (target && target.to !== app.demo_base_sha) return failed(409, { error: 'The demo reset target changed. Reset again.' });
  const main = await steps.once('main', async () => {
    if (planned) {
      const current = await github.getBranchSha(repo.owner, repo.repo, 'main');
      if (current !== planned.to) {
        if (!planned.moved) {
          planned = { ...planned, from: current, moved: true };
          await steps.set('main-target', planned);
        }
        await github.forceBranchToSha(repo.owner, repo.repo, 'main', planned.to);
      }
    }
    return planned;
  });
  await refreshPartnerStanding(pool, app, partner, user.id);

  // Production follows main: a recorded request the app-delivery machine
  // runs, as the redeploy route in routes/apps.js asks it.
  let redeploy = 'skipped';
  if (main && main.moved) {
    redeploy = 'started';
    // The reset is done by now: a request that cannot be recorded is
    // logged, not this reset's error.
    await steps.once('deploy', () => require('../workflow/platform.ts').requestDeploy(app.id, 'demo_reset').then(() => true)
      .catch((err) => {
        log.warn('demo-mode', 'Deploy request after reset failed', { slug: app.slug, err: err.message });
        return false;
      }));
  }
  log.info('demo-mode', 'Demo reset', { slug: app.slug, removed, main, redeploy });
  return { sessionsRemoved: removed, main, redeploy };
}

async function run(deps, request, user, steps) {
  if (request.op === 'demo.reset') return reset(deps, request, user, steps);
  const out = await steps.once('result', () => propose(deps, request, user, steps));
  // Answered: nothing reads the proposal's input again (a throw is tried
  // again, and keeps it).
  await require('./platform-operations').dropInput(deps.pool, request.requestId);
  return out;
}

module.exports = {
  authorize, run,
  fenceOf, loadPartner, refreshPartnerStanding, partnerSessions, openDemoSession, promoteAsPartner,
};
