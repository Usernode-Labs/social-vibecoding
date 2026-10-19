'use strict';

// Scan existing imported apps for privacy violations. Homeroom workers
// run with zero GitHub credentials and rely on unauthenticated public
// HTTPS clones; a private repo can't be cloned by the worker, so dev
// sessions against it will fail at bootstrap. Surface those rows once
// a day (the `repo-privacy-audit` clock, src/workflow/clock/services.ts)
// so the operator can decide whether to ask the user to make the repo
// public or delete the import. Daily, not at every election: on 19 Oct
// 2026 the leader changed some twenty times (eight in one hour), and each
// one spent a GitHub read per app (~150) on a result that is only logged.
// Every worker start checks the repo itself (services/worker.js,
// routes/internal.js), so nothing waits on this.
//
// Bounded concurrency (a small pool) keeps the scan from spending
// minutes on a large `apps` table. The check is purely read-only — we
// log and move on — and stops at its next row once its run is stopped.
// Resolves what it found.

const log = require('./logger');

async function audit(pool, { shouldStop = () => false } = {}) {
  const github = require('./github');
  const { rows } = await pool.query(
    `SELECT id, slug, repo_url FROM apps
     WHERE repo_url IS NOT NULL AND status != 'archived'`
  );
  if (!rows.length) return { total: 0, private: 0, errors: 0 };

  log.info('server', 'Starting private-repo audit', { count: rows.length });

  // Cap concurrency so a 100-row deployment doesn't fire 100 GitHub
  // API calls in parallel and trip secondary rate limits.
  const CONCURRENCY = 4;
  const queue = rows.slice();
  let privateCount = 0;
  let errorCount = 0;

  // One read per app, and only a log line comes of it, so it is the first
  // thing to give way when GitHub's hourly budget is nearly used up
  // (services/github-budget.js): a run right after the budget ran out must
  // not spend what is left on an audit.
  const githubBudget = require('./github-budget');
  let held = false;
  async function worker() {
    while (queue.length && !shouldStop()) {
      if (!githubBudget.budgetAllows('background')) { held = true; return; }
      const row = queue.shift();
      const m = (row.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!m) continue;
      const [, owner, repo] = m;
      try {
        const result = await github.checkRepoPublic(owner, repo);
        if (!result.ok) {
          errorCount++;
          log.warn('server', 'private-repo audit: lookup failed', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`, err: result.message,
          });
        } else if (result.private) {
          privateCount++;
          log.warn('server', 'private-repo audit: app references a PRIVATE repo (dev sessions will fail)', {
            appId: row.id, slug: row.slug, repo: `${owner}/${repo}`,
          });
        }
      } catch (err) {
        errorCount++;
        log.warn('server', 'private-repo audit: unexpected error', {
          appId: row.id, slug: row.slug, err: err.message,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const summary = {
    total: rows.length, private: privateCount, errors: errorCount,
    ...(held ? { heldForGithubBudget: queue.length } : {}),
  };
  log.info('server', 'Private-repo audit complete', summary);
  // A run stopped or held before the end is no audit: it fails, and the
  // clock tries again sooner.
  if (queue.length) throw new Error(held ? 'held for GitHub\'s hourly budget' : 'stopped before the end');
  return summary;
}

module.exports = { audit };
