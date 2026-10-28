'use strict';

// What the platform reads about its proposals from outside: GitHub and the
// apps' mirrors. Each is a clock of the workflow (src/workflow/clock/
// services.ts) that hands what it read to the proposal machine, which
// decides every consequence under the proposal's lock (a head that moved
// is ReviewHeadMoved, a merge on GitHub is merge-followups' Merged, a pull
// request closed there is the proposal's Close, a sync with main is
// SyncRequested). They replaced the leader's session sweeper's imported-PR
// pass, its measurement timer, the stale-PR sweeper's revision pass and the
// six-hourly merged-by-hand lookup: none of them is limited to the oldest
// fifty any more, and none keeps a cooldown in memory.

const log = require('./logger');
const repoRef = require('./repo-ref');

const platform = () => require('../workflow/platform.ts');

// A page's bounds: the id after which it starts, and how many it takes.
const bounds = ({ after = null, limit = 200 } = {}) => [Number.isInteger(after) && after > 0 ? after : 0, limit];

// A page of sessions (selected after the first bound, by id, as many as the
// second) as clock targets, with where the next page starts.
function paged(rows, limit) {
  return {
    listed: rows.length,
    after: rows.length >= limit ? Number(rows[rows.length - 1].id) : null,
    items: rows.map((r) => ({ target: `session:${r.id}`, input: { sessionId: Number(r.id) } })),
  };
}

const ROW_SQL = `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url, a.self_hosted AS app_self_hosted
                   FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id`;

async function rowOf(pool, sessionId) {
  const { rows: [row] } = await pool.query(`${ROW_SQL} WHERE cs.id = $1`, [sessionId]);
  return row || null;
}

// A turn on the session, on any process: it is about to move the head, so
// what is read now is wrong before it is used.
function busy(sessionId, pool) {
  return require('./active-workers').isSessionBusyAnywhere(Number(sessionId), { pool });
}

// GitHub's hourly budget is shared: background reads wait while it is
// nearly spent (services/github-budget.js).
function budgetAllows() {
  return require('./github-budget').budgetAllows('background');
}

// ── Imported pull requests ──────────────────────────────────────────────

// Every open imported proposal that is open on Homeroom, each a target of its
// own (lookImported): its pull request's head, description, and whether
// GitHub merged or closed it. A page at a time (the clock takes at most
// `limit` targets a run): the ones after `after`, by id, and `after` for the
// next run, null once the list has been gone through.
async function importedTargets(pool, { after = null, limit = 200 } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM chat_sessions
      WHERE source = 'imported' AND status IN ('active', 'promoted', 'merging') AND pr_number IS NOT NULL
        AND id > $1 ORDER BY id LIMIT $2`, bounds({ after, limit }));
  return paged(rows, limit);
}

// One imported proposal looked at (services/pr-import-sync.js
// syncImportedProposal, which the webhook also calls): resolves what it
// found. A turn on it, or a spent budget, is a look skipped; the next run
// looks again.
async function lookImported(config, pool, sessionId) {
  const session = await rowOf(pool, sessionId);
  if (!session || session.source !== 'imported' || !['active', 'promoted', 'merging'].includes(session.status) || !session.pr_number) {
    return { skipped: 'gone' };
  }
  if (await busy(session.id, pool)) return { skipped: 'busy' };
  if (!budgetAllows()) return { skipped: 'budget' };
  return { outcome: await require('./pr-import-sync').syncImportedProposal({ config, pool, session }) };
}

// ── Native pull requests merged by hand ─────────────────────────────────

// Every native proposal up for a vote, a page at a time (as
// importedTargets), each a target (lookMergedByHand):
// one merged by hand on GitHub is recorded. Nothing else notices such a
// merge (a merge the platform attempted is the proposal machine's own).
async function mergedByHandTargets(pool, page = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM chat_sessions
      WHERE status = 'promoted' AND pr_number IS NOT NULL AND source IS DISTINCT FROM 'imported'
        AND id > $1 ORDER BY id LIMIT $2`, bounds(page));
  return paged(rows, bounds(page)[1]);
}

async function lookMergedByHand(pool, sessionId) {
  const github = require('./github');
  if (!github.isEnabled()) return { skipped: 'no_github' };
  const { rows: [row] } = await pool.query(
    `SELECT cs.id, cs.app_id, cs.pr_number, cs.status, a.repo_url
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id WHERE cs.id = $1`, [sessionId]);
  if (!row || row.status !== 'promoted' || !row.pr_number) return { skipped: 'gone' };
  const repo = repoRef.ownerRepo(row.repo_url);
  if (!repo) return { skipped: 'no_repo' };
  if (!budgetAllows()) return { skipped: 'budget' };
  const githubBudget = require('./github-budget');
  let pr;
  try {
    pr = await github.getPR(repo.owner, repo.repo, row.pr_number);
  } catch (err) {
    if (githubBudget.isRateLimitError(err)) return { skipped: 'budget' };
    throw err;
  }
  if (!pr || !pr.merged) return { merged: false };
  const taken = await platform().prLooked({
    sessionId: row.id, appId: row.app_id, from: row.status, merged: true, closed: pr.state === 'closed',
    mergeSha: pr.merge_commit_sha || null, mergedAt: pr.merged_at || null, closedAt: pr.closed_at || null,
    base: require('../workflow/rules/pr-base.ts').otherBase(pr),
  });
  if (taken) log.info('proposal-scans', 'A pull request merged by hand on GitHub was recorded', { sessionId: row.id, prNumber: row.pr_number });
  return { merged: taken };
}

// ── Revisions of proposals in review ────────────────────────────────────

// Every native proposal in review, a page at a time (as importedTargets),
// each a target (refreshRevision): its
// branch can be pushed outside Homeroom, and a protected-settings flag can
// go stale once main moves.
async function revisionTargets(pool, page = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM chat_sessions WHERE status = 'promoted' AND is_headless = FALSE
        AND id > $1 ORDER BY id LIMIT $2`, bounds(page));
  return paged(rows, bounds(page)[1]);
}

// The reviewed head read again (a move is the proposal machine's
// ReviewHeadMoved, routes/votes.js reconcileNativeReviewedHead), then the
// explicit-approval flag (services/app-admins.js sweepExplicitApproval).
async function refreshRevision(config, pool, sessionId) {
  const session = await rowOf(pool, sessionId);
  if (!session || session.status !== 'promoted' || session.is_headless) return { skipped: 'gone' };
  if (await busy(session.id, pool)) return { skipped: 'busy' };
  const revision = await require('../routes/votes').reconcilePromotedSweepHead({ config, pool, session });
  if (revision.blocked) {
    log.warn('proposal-scans', 'Revision refresh skipped: native revision unavailable', {
      sessionId: session.id, transient: !!revision.transient, reason: revision.reason,
    });
    return { skipped: 'blocked', transient: !!revision.transient };
  }
  // Its branch is not on the git host: the code did not come across when
  // Homeroom moved off GitHub (services/code-missing.js). There is no head to
  // diff the protected settings of, so the pass moves on without a word,
  // and looks again next time (a branch pushed back is picked up then).
  if (revision.codeMissing) return { skipped: 'code_missing' };
  await require('./app-admins').sweepExplicitApproval(pool, session);
  return { refreshed: true };
}

// ── Measured against main ───────────────────────────────────────────────

// Every proposal in review measured against its app's main (#2038): how far
// behind, whether it merges cleanly, whether the base its checks passed
// against is still on main. One fetch of an app's mirror serves every open
// proposal on it (integration.fetchAppMirror). The measurement writes the
// measured columns only: the merge gate's own reasons stay as the gate
// wrote them (integration.measure without blockReasons). `shouldStop` ends
// it at the next proposal.
async function measurePromoted(pool, { shouldStop = () => false } = {}) {
  const integration = require('./integration');
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.repo_url
       FROM chat_sessions cs JOIN apps a ON cs.app_id = a.id
      WHERE cs.status = 'promoted' AND a.repo_url IS NOT NULL AND cs.branch_name IS NOT NULL
      ORDER BY cs.app_id, cs.integration_measured_at NULLS FIRST`);
  const byApp = new Map();
  for (const row of rows) {
    if (!byApp.has(row.app_id)) byApp.set(row.app_id, []);
    byApp.get(row.app_id).push(row);
  }
  let measured = 0;
  for (const sessions of byApp.values()) {
    if (shouldStop()) break;
    const working = await require('./active-workers').busySessionsAnywhere(sessions.map((s) => s.id), { pool });
    const ready = sessions.filter((session) => !working.has(Number(session.id)));
    if (!ready.length) continue;
    // A fetch that fails leaves each measurement to fetch for itself, so
    // each records the failure as its own.
    const mirrorDir = await integration.fetchAppMirror(ready).catch((err) => {
      log.warn('proposal-scans', 'Could not fetch an app\'s mirror for its proposals', { appId: ready[0].app_id, err: err.message });
      return null;
    });
    for (const session of ready) {
      if (shouldStop()) break;
      const written = await integration.measure({ pool, session }, { force: true, ...(mirrorDir ? { mirrorDir } : {}) });
      if (written && !written.skipped) measured++;
    }
  }
  return { promoted: rows.length, apps: byApp.size, measured };
}

// ── A check main has fixed ──────────────────────────────────────────────

// services/fixed-check-sync.js sweep, as the clock's run: each sync it asks
// for is the proposal machine's to decide (once per head). `previous` is
// the last run's result: a decline is logged once, when its reason changes.
async function fixedCheckSync(config, pool, { previous = null, shouldStop = () => false } = {}) {
  const fixed = require('./fixed-check-sync');
  if (!fixed.isEnabled()) return { off: true };
  const result = await fixed.sweep({ config, pool, shouldStop });
  if (result.candidates) log.info('fixed-check-sync', 'Fixed-on-main sweep', { ...result, skipped: undefined });
  const seen = new Map(Object.entries(previous?.declined || {}));
  const fresh = fixed.freshDeclines(result.skipped, seen);
  if (Object.keys(fresh).length) {
    log.info('fixed-check-sync', 'Proposals with failing checks not synced with main', {
      declined: Object.fromEntries(Object.entries(fresh).map(([id, why]) => [id, { why, words: fixed.declinedWords(why) }])),
    });
  }
  // Only the proposals still declined are remembered.
  const declined = Object.fromEntries(Object.keys(result.skipped || {}).map((id) => [id, seen.get(id)]));
  return { apps: result.apps, candidates: result.candidates, synced: result.synced, declined };
}

module.exports = {
  importedTargets,
  lookImported,
  mergedByHandTargets,
  lookMergedByHand,
  revisionTargets,
  refreshRevision,
  measurePromoted,
  fixedCheckSync,
};
