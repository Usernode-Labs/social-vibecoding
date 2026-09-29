// Claiming a GitHub issue — one definition, three callers.
//
// A claim is a per-user issue_claims row (see schema.sql) that marks the
// issue "In progress" for its claimer, plus the claimer's assignee vote on
// the issue (#1648), so taking the work and assigning it are one gesture.
//
// Three surfaces create one:
//   1. POST /api/apps/:slug/github-issues/:number/claim (src/routes/issues.js)
//      — the explicit "Claim this issue" button and the connector's
//      claim_request tool.
//   2. POST /api/apps/:slug/sessions with an issueNumber (#2364) — "Start
//      work" on an issue card opens a session on it.
//   3. POST /api/apps/:slug/issues/:number/headless-session (#2364) —
//      "Generate proposal" and the connector's start_platform_build.
//
// Every caller confirms the issue is OPEN before calling in here; this
// module writes, it does not verify. Both writes are platform-local — no
// GitHub write. The route surfaces a failure as a 500; the session routes
// treat a claim as best-effort and never fail session creation over it.
'use strict';

const log = require('./logger');
const topicAttrs = require('./topic-attributes');

// Upsert `user`'s own claim on `issueNumber`, move their assignee vote to
// themselves, and announce a FRESH claim in the issue's discussion thread.
// Returns { created, claimedAt }. Throws if the upsert or the vote fails.
async function claimIssueForUser(pool, { app, issueNumber, user }) {
  // Lazy, and read off the module object at call time: ws requires half the
  // service layer, and the route tests stub its exports (or the whole module
  // via require.cache) after this file may already be loaded.
  const ws = require('./ws');

  // `xmax = 0` distinguishes a fresh INSERT (announce in the thread) from a
  // renewal (silent — the claimer just restarted their clock).
  const { rows } = await pool.query(
    `INSERT INTO issue_claims (app_id, github_issue_number, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (app_id, github_issue_number, user_id)
       DO UPDATE SET claimed_at = NOW()
     RETURNING claimed_at, (xmax = 0) AS created`,
    [app.id, issueNumber, user.id]
  );
  const created = !!rows[0]?.created;

  // #1648: claiming is an explicit statement that the caller is taking
  // the issue, so mirror it into the existing community-voted assignee
  // field. Do this on renewals too: re-claiming repairs a missing or
  // independently changed self-assignment. Releasing remains separate —
  // it must not erase metadata that the user may have edited afterward.
  await topicAttrs.castVote(
    pool, app.id, 'issue', issueNumber, 'assignee', user.username, user.id
  );

  if (created) {
    // On-the-record note in the issue's own discussion thread (which
    // also freshens the thread clock every claim keys off).
    await ws.sendSystemMessage(pool, app.id,
      // #1112: "claimed" rather than "marked this issue in progress" —
      // a claim is one of seven things the board used to call "In
      // progress", and it is the only one this creates. Rows already
      // written keep their old wording; not worth a migration.
      `${user.username} claimed this issue`,
      'system', null, { type: 'issue', ref: issueNumber }
    ).catch((err) => log.warn('issues', 'Claim chat message failed', { err: err.message }));
  }

  if (typeof ws.pushIssueUpdate === 'function') {
    ws.pushIssueUpdate({
      action: 'claimed', appSlug: app.slug, appId: app.id, issueNumber,
    });
  }

  return { created, claimedAt: rows[0]?.claimed_at || null };
}

module.exports = { claimIssueForUser };
