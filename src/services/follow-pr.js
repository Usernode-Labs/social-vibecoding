'use strict';

// Whether a version gets its original's updates, as a proposal
// (docs/plans/versions.md, "Remixes and lineage").
//
// Following is a line of the version's dapp.json, `followOriginal`, so
// changing it is a vote like any other line there: this opens the manifest
// PR that sets it (services/rename-pr.js createManifestPR, the core every
// settings proposal shares), and when it merges the production rebuild's
// app-manifest.reconcileAppFollow writes it into `apps.upstream.following`.
// The route is POST /api/apps/:slug/follow-pr (routes/versions.js), run on a
// conductor as the `manifest.propose` operation's `follow` flavor
// (services/manifest-proposal-operation.js). One in flight per project.
//
// It touches no protected block (services/explicit-approval.js): an update
// it lets through is itself a proposal its group votes on, so the ordinary
// merge rule decides it.

const renamePr = require('./rename-pr');

const BRANCH_PREFIX = 'follow';

// The proposal's title, in the words people read: "Get Tier list's
// updates" / "Stop getting Tier list's updates".
function followPrTitle(follow, originalName) {
  const name = String(originalName || '').trim() || 'the original';
  return follow ? `Get ${name}'s updates` : `Stop getting ${name}'s updates`;
}

/**
 * Open the proposal that sets `followOriginal` to `follow` in `app`'s
 * dapp.json. `originalName` is the original's name as the version shows it.
 * The caller (the route, then the operation's authorize) owns who may ask
 * and the one-in-flight check (findFollowPr). Resolves
 * { sessionId, prNumber, prUrl, branch }.
 */
async function createFollowPR(config, pool, app, { follow, originalName }, actor, { steps } = {}) {
  const title = followPrTitle(follow, originalName);
  const who = actor.username || 'Someone';
  return renamePr.createManifestPR(config, pool, app, actor, {
    steps,
    mutate: (m) => { m.followOriginal = !!follow; },
    branchPrefix: BRANCH_PREFIX,
    commitMessage: title,
    prTitle: title,
    prBody: follow
      ? `${who} (via Homeroom) proposed that "${app.name}" gets ${originalName || 'the original'}'s updates.\n\n`
        + 'This sets `followOriginal` to true in `dapp.json`. Once it merges, each change merged in the original '
        + 'is offered here as an update, which this group votes on like any other change.'
      : `${who} (via Homeroom) proposed that "${app.name}" stops getting ${originalName || 'the original'}'s updates.\n\n`
        + 'This sets `followOriginal` to false in `dapp.json`. Once it merges, nothing more is offered here on its '
        + 'own; the project page still says when the original has changed.',
    chatText: (prData, majority, activeUsers) =>
      `${who} proposed: ${title}. Opened PR #${prData.number}, which needs ${majority}/${activeUsers} votes to land.`,
    eventMetadata: { followOriginal: !!follow },
  });
}

/** The open proposal to change whether this project gets its original's updates, or null. */
async function findFollowPr(pool, appId) {
  const { rows } = await pool.query(
    `SELECT id, pr_number, pr_url, pr_title FROM chat_sessions
      WHERE app_id = $1 AND status IN ('promoted', 'merging')
        AND branch_name LIKE 'follow/%'
      ORDER BY id DESC
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

module.exports = { BRANCH_PREFIX, createFollowPR, findFollowPr, followPrTitle };
