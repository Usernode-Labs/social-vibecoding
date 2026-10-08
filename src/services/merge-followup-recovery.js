'use strict';

// Resume the two required outcomes of a confirmed GitHub merge. Their
// completion markers already live on apps: main_sha records delivery and
// main_check_sha/state records the combined-main run. Staging cleanup has its
// own sweeper; incidental messages must not be replayed here.
const log = require('./logger');
const github = require('./github');
const staging = require('./staging');
const mainWatch = require('./main-watch');
const mergeLock = require('./merge-finalization-lock');
const githubBudget = require('./github-budget');
const { getPool } = require('../db/pool');

// main's tip through the drift poller's conditional read: this sweep runs
// every four minutes over every app with a merged proposal, and an unchanged
// main then answers 304, which GitHub does not count against the hourly
// budget. The two sweeps share one ETag per repo. Required lazily, so
// loading this module does not load the poller and everything it requires.
async function remoteMain(owner, repo) {
  const head = await require('./main-drift-poller').fetchRemoteHead(owner, repo);
  return head.sha || null;
}

async function recover(config, {
  pool = getPool(config), getMain = remoteMain,
  rebuild = staging.rebuildProduction, check = mainWatch.afterMerge,
  enabled = github.isEnabled,
  // Background work: while GitHub's hourly budget is nearly used up, the
  // rest of the sweep waits for a later tick (services/github-budget.js).
  allowed = () => githubBudget.budgetAllows('background'),
} = {}) {
  if (!enabled()) return { scanned: 0, delivered: 0, checks: 0, done: Promise.resolve([]) };
  // The newest confirmed merge per app is enough: a newer main contains its
  // predecessors. GitHub main is read below so a later direct push is also
  // tested/delivered rather than replacing it with an older merge commit.
  // A change that went live inside another one (included_in_session_id,
  // services/included-changes.js) shares that merge's commit and time but is
  // not the merge: the carrying change is the one its follow-ups belong to.
  const { rows } = await pool.query(
    `WITH latest AS (
       SELECT DISTINCT ON (cs.app_id)
              cs.id AS session_id, cs.pr_number, cs.merge_commit_sha,
              a.*
         FROM chat_sessions cs
         JOIN apps a ON a.id = cs.app_id
        WHERE cs.status = 'merged' AND cs.pr_number IS NOT NULL
          AND cs.included_in_session_id IS NULL
        ORDER BY cs.app_id, cs.merged_at DESC NULLS LAST, cs.id DESC
     )
     SELECT * FROM latest`
  );
  let delivered = 0;
  let checks = 0;
  let held = false;
  const runs = [];
  for (const row of rows) {
    if (!allowed()) { held = true; break; }
    const release = await mergeLock.acquire(pool, row.session_id, { tryOnly: true });
    if (!release) continue; // The normal finalizer is still running.
    try {
      const parsed = github.parseGithubUrl(row.repo_url);
      if (!parsed) continue;
      let sha;
      try {
        sha = await getMain(parsed.owner, parsed.repo);
        if (!/^[a-f0-9]{40}$/i.test(sha || '')) continue;
      } catch (err) {
        log.warn('merge-recovery', 'Could not read main for follow-up recovery', {
          appId: row.id, err: err.message,
        });
        continue;
      }

      // A suite that started before interruption is owned by main-watch's
      // stale-run recovery. Its atomic claim also stops a concurrent finalizer
      // from launching another suite for this same SHA.
      if (row.main_check_sha !== sha || !row.main_check_state || row.main_check_state === 'error') {
        checks++;
        const session = sha === row.merge_commit_sha
          ? { id: row.session_id, pr_number: row.pr_number } : null;
        runs.push(Promise.resolve().then(() => check(config, pool, {
          app: row, session, mergeSha: sha,
        })).catch((err) => {
          log.warn('merge-recovery', 'Combined-main check recovery failed', {
            appId: row.id, sha, err: err.message,
          });
        }));
      }

      // The self-hosted app is released by the host/cluster deployer and its
      // release watch. A child app with an older recorded SHA needs delivery.
      if (row.self_hosted || row.main_sha === sha) continue;
      try {
        const result = await rebuild(config, row, { reuseRunningRevision: sha });
        const saved = await pool.query(
          `UPDATE apps SET container_id = $1, main_sha = $2,
                           main_pr_number = $3, last_deploy_at = NOW()
            WHERE id = $4 AND main_sha IS NOT DISTINCT FROM $5`,
          [result.containerId || null, result.sha || sha,
            result.sha === row.merge_commit_sha ? row.pr_number : null, row.id, row.main_sha]
        );
        if (saved.rowCount) delivered++;
      } catch (err) {
        // Production failure remains on apps.last_failure. Keep source merge
        // state intact; the next sweep and the existing drift poller retry it.
        log.warn('merge-recovery', 'Production delivery recovery failed', {
          appId: row.id, sha, err: err.message,
        });
      }
    } finally {
      await release();
    }
  }
  return { scanned: rows.length, delivered, checks, held, done: Promise.all(runs) };
}

function start(config, { intervalMs = 4 * 60 * 1000 } = {}) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    recover(config).catch((err) => {
      log.warn('merge-recovery', 'Follow-up sweep failed', { err: err.message });
    }).finally(() => { running = false; });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = { recover, start };
