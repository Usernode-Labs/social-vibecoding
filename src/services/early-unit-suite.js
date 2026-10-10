'use strict';

// The repo unit suite, started with the preview build instead of after it.
//
// A checks run has two halves that run side by side: the browser checks,
// which need the preview, and the repo's unit suite, which clones the repo
// itself and never touches the preview. Yet the unit suite was launched
// from captureForSession, so it waited for the preview's image build, its
// boot and the checks slot before it started. On the platform's own app
// from 8 to 10 October 2026 that wait was about 70s (a 53s image build and
// a 13s boot at the median), in front of a 168s suite that was already the
// longest part of every run.
//
// So when a preview is built for a head whose checks are pending, the unit
// suite starts at once (maybeStart, from staging.buildAndDeployStaging),
// and the checks run that follows takes it over (adopt) instead of
// launching its own. Everything after that is as before: the run awaits it
// beside the browser checks, records it in its manifest so the harvest can
// read it after a restart, and stores its row.
//
// The early Job is named `sv-unit-early-…`, outside the preview run's own
// check Jobs, because the preview lifecycle cancels those whenever one of
// its operations starts or ends, and the build is one operation and the
// checks run another. This module therefore cancels it itself: when the
// head moves on, when the checks run that adopted it is cancelled, when the
// run defers its verdict, and when nobody adopts it in time.
//
// It only starts while fewer unit-suite Jobs are running than the checks
// queue lets runs go at once (services/checks-queue.js), so a burst of
// builds cannot fill the worker namespace's quota ahead of the runs the
// queue admits. Not started at all, the run launches its own suite as it
// always did. EARLY_UNIT_SUITE=0 turns this off.
//
// In-process: the build and the checks run that follows it run in the same
// process. A run in another process, or after a restart, finds nothing here
// and runs its own suite.

const crypto = require('crypto');
const log = require('./logger');

const JOB_NAME_PREFIX = 'sv-unit-early';
// How long a run nobody adopted may go on. Past a build (a few minutes at
// worst), a wait for a checks slot and the suite's own deadline.
const ADOPT_WITHIN_MS = 25 * 60 * 1000;

const runs = new Map();

function isEnabled(config) {
  const v = String(process.env.EARLY_UNIT_SUITE ?? '1').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  return config?.workerRuntime === 'kubernetes';
}

function jobName(sessionId, runId) {
  return require('./kubernetes').checkJobRunName('unit-suite', sessionId, runId, JOB_NAME_PREFIX);
}

// Stop an early run: its Job, its entry. Never throws.
function abandon(config, entry, why) {
  if (!entry || entry.abandoned) return;
  entry.abandoned = true;
  clearTimeout(entry.expiry);
  if (runs.get(entry.sessionId) === entry) runs.delete(entry.sessionId);
  try { entry.controller.abort(new Error(why)); } catch { /* already aborted */ }
  log.info('early-unit-suite', 'Stopped an early unit suite', {
    sessionId: entry.sessionId, commitHash: entry.commitHash, why, adopted: entry.adopted,
  });
  require('./kubernetes').deleteCheckJob(config, jobName(entry.sessionId, entry.runId)).catch(() => {});
}

/**
 * Start the unit suite for a preview build of `commitHash`, when that head's
 * checks are pending and the cluster has room. Fire-and-forget; never throws.
 * Returns the run's entry, or null when it did not start.
 */
async function maybeStart(config, { session, app, commitHash, pool = null, deps = {} } = {}) {
  try {
    if (!isEnabled(config) || !session || !app) return null;
    const sha = String(commitHash || '');
    if (!/^[0-9a-f]{40}$/i.test(sha)) return null;
    const sessionId = Number(session.id);
    const unitSuite = deps.unitSuite || require('./unit-suite');
    if (!unitSuite.isEnabled()) return null;
    const existing = runs.get(sessionId);
    if (existing && existing.commitHash === sha) return existing;
    if (existing) abandon(config, existing, 'a newer head is being built');

    const [, repoOwner, repoName] = (app.repo_url || '').match(/github\.com\/([^/]+)\/([^/]+)/) || [];
    if (!repoOwner || !repoName) return null;
    const db = pool || require('../db/pool').getPool(config);
    const { rows } = await db.query(
      `SELECT id, status, check_state, checks_commit_sha, branch_name, pr_number, source,
              handoff_head_sha, imported_pr_head_sha
         FROM chat_sessions WHERE id = $1`,
      [sessionId]
    );
    const row = rows[0];
    // Only a build the checks are waiting on: the head they are pinned to,
    // still pending, on a session that can still be judged.
    if (!row || row.check_state !== 'pending' || row.checks_commit_sha !== sha
        || !['active', 'paused', 'promoted', 'merging'].includes(row.status)) return null;
    const ref = (deps.sessionGitRef || require('./visuals').sessionGitRef)({ ...session, ...row }, sha);
    if (!ref) return null;

    const kubernetes = deps.kubernetes || require('./kubernetes');
    const cap = (deps.checksQueue || require('./checks-queue')).maxConcurrentRuns();
    const running = await kubernetes.countRunningUnitSuiteJobs(config);
    if (running === null || (cap > 0 && running >= cap)) {
      log.info('early-unit-suite', 'Not starting the unit suite early: the cluster is busy', {
        sessionId, commitHash: sha, running, cap,
      });
      return null;
    }
    // Checked again after the awaits: a newer build may have started one.
    const raced = runs.get(sessionId);
    if (raced && raced.commitHash === sha) return raced;
    if (raced) abandon(config, raced, 'a newer head is being built');

    const entry = {
      sessionId, commitHash: sha, ref, runId: crypto.randomUUID(),
      controller: new AbortController(), startedAt: Date.now(),
      last: null, observers: new Set(), adopted: false, abandoned: false, settled: false,
    };
    entry.promise = unitSuite.maybeRunUnitSuite({
      config, pool: db, appId: app.id, sessionId, repoOwner, repoName, ref,
      prNumber: Number(row.pr_number) || null,
      onProgress: (snap) => {
        entry.last = snap;
        for (const observe of entry.observers) {
          try { observe(snap); } catch { /* an observer must not break the run */ }
        }
      },
      signal: entry.controller.signal, previewRunId: entry.runId, jobNamePrefix: JOB_NAME_PREFIX,
    }).catch((err) => {
      if (!entry.abandoned) {
        log.warn('early-unit-suite', 'Early unit suite failed to run (non-fatal)', {
          sessionId, commitHash: sha, err: err.message,
        });
      }
      return null;
    }).finally(() => {
      entry.settled = true;
      if (entry.adopted && runs.get(sessionId) === entry) runs.delete(sessionId);
    });
    entry.expiry = setTimeout(() => {
      if (!entry.adopted) abandon(config, entry, 'no checks run took it over');
    }, ADOPT_WITHIN_MS);
    if (typeof entry.expiry.unref === 'function') entry.expiry.unref();
    runs.set(sessionId, entry);
    log.info('early-unit-suite', 'Started the unit suite with the preview build', {
      sessionId, commitHash: sha, runId: entry.runId, running, cap,
    });
    return entry;
  } catch (err) {
    log.warn('early-unit-suite', 'Could not start the unit suite early (non-fatal)', {
      sessionId: session && session.id, err: err.message,
    });
    return null;
  }
}

/**
 * The checks run for `commitHash` takes over the early run of that head, if
 * there is one: `{ promise, runId }`, or null. `onProgress` hears the last
 * snapshot at once and every one after; a `signal` that aborts stops the run.
 */
function adopt(config, sessionId, commitHash, ref, { onProgress = null, signal = null } = {}) {
  const entry = runs.get(Number(sessionId));
  if (!entry || entry.adopted || entry.abandoned) return null;
  if (entry.commitHash !== commitHash || entry.ref !== ref) return null;
  entry.adopted = true;
  clearTimeout(entry.expiry);
  if (entry.settled) runs.delete(entry.sessionId);
  if (typeof onProgress === 'function') {
    entry.observers.add(onProgress);
    if (entry.last) {
      try { onProgress(entry.last); } catch { /* best-effort */ }
    }
  }
  if (signal) {
    const stop = () => abandon(config, entry, 'the checks run that took it over was cancelled');
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  }
  log.info('early-unit-suite', 'Checks run took over the early unit suite', {
    sessionId: entry.sessionId, commitHash, runId: entry.runId,
    startedSecondsAgo: Math.round((Date.now() - entry.startedAt) / 1000), finished: entry.settled,
  });
  // `stop` is for a run that ends without its verdict: this run, and no
  // newer head's.
  return { promise: entry.promise, runId: entry.runId, stop: (why) => abandon(config, entry, why) };
}

/** Stop the session's early run of `commitHash`; a newer head's is left alone. */
function cancel(config, sessionId, why, { commitHash } = {}) {
  const entry = runs.get(Number(sessionId));
  if (entry && (!commitHash || entry.commitHash === commitHash)) abandon(config, entry, why);
}

module.exports = { isEnabled, maybeStart, adopt, cancel, jobName, JOB_NAME_PREFIX, ADOPT_WITHIN_MS, _runs: runs };
