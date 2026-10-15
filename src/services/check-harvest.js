'use strict';

// Read a checks run's Jobs after the process that launched them is gone.
//
// A platform rollout replaces every platform Pod, and every merge to the
// self-app is a rollout. A checks run in flight at that moment loses the
// process that was streaming its capture and unit-suite Jobs — but the Jobs
// themselves are the cluster's, not the Pod's, and they run to completion
// regardless. #2125 paid four full suites in half an hour starting them over.
//
// The preview machine's checks run is a work item (src/workflow/preview/
// services.ts checks.run). Its manifest is recorded in check_runs before its
// Jobs exist (services/check-runs.js); when its claim is lost (its process
// died, or its lease ran out), the retry of the same work item collects the
// Jobs that manifest names (collectForWorkflow) rather than running the
// checks again. The other way round, a run starting stops the Jobs of the
// runs it supersedes (stopSupersededRuns), so they stop holding the capacity
// it needs. main-watch reads its own interrupted unit suites with
// joinUnitResults.

const log = require('./logger');
const checkRuns = require('./check-runs');

// Slack past the Jobs' own activeDeadlineSeconds before a still-running Job
// is given up on — the cluster should have ended it by then.
const DEADLINE_SLACK_MS = 30_000;

function isEnabled(config) {
  return (config?.captureRuntime || process.env.CAPTURE_RUNTIME) === 'kubernetes';
}

// A run's capture shards, collected, read as one capture Job: their output
// joined in shard order, as the live run joins it (visuals.runCaptureShards).
// One shard gone, aborted or past its deadline is the run's state; the run
// failed only if every shard did. `notStarted` names the shards that
// reported nothing because their Pod never started its container, or was
// evicted (check-pod-start.js), as the live run's do.
function capturePodNeverStarted(result, shard) {
  if (!result || result.state === 'succeeded') return null;
  const fault = require('./check-pod-start').podStartCause(result.podStart);
  if (!fault) return null;
  return require('./visuals').reportedTestIndexes(String(result.stdout || '')).size ? null : { shard, ...fault };
}

function joinCaptures(results) {
  const list = (results || []).filter(Boolean);
  const notStarted = list.map((r, shard) => capturePodNeverStarted(r, shard)).filter(Boolean);
  if (list.length <= 1) {
    const one = list[0] || null;
    return one && notStarted.length ? { ...one, notStarted } : one;
  }
  const worst = ['gone', 'aborted', 'timeout'].find((state) => list.some((r) => r.state === state));
  return {
    state: worst || (list.every((r) => r.state === 'failed') ? 'failed' : 'succeeded'),
    stdout: list.map((r) => String(r.stdout || '')).join('\n'),
    stderr: list.map((r) => String(r.stderr || '')).filter(Boolean).join('\n'),
    partial: list.some((r) => r.partial),
    partialReason: [...new Set(list.map((r) => r.partialReason).filter(Boolean))].join('; '),
    notStarted,
  };
}

// A run's unit-suite shards, collected, read as one Job: the outputs joined
// as the live run joins them (unit-suite.joinUnitShardOutputs). A shard
// that failed or ran out of time makes the suite red, whatever the others
// say or whether they could be read at all: a missing shard cannot make it
// pass. Short of that, part of a suite is not the suite: null, no row, when
// a shard is missing, and one gone or aborted is the suite's state. It
// succeeded only if every shard did.
function joinUnitResults(results, expectedShards = 1) {
  const list = (results || []).filter(Boolean);
  if (list.length <= 1 && expectedShards <= 1) return list[0] || null;
  // A shard whose Pod never started its container and printed nothing: the
  // suite did not run, whatever the others say, as the live path reads it
  // (unit-suite.runUnitSuiteShards). Its own empty log is what is read.
  const neverRan = list.find((r) => r.state !== 'succeeded' && !String(r.stdout || '').trim()
    && require('./check-pod-start').podStartCause(r.podStart));
  if (neverRan) return { ...neverRan, shardNotRun: true };
  const red = list.filter((r) => r.state === 'failed' || r.state === 'timeout');
  if (list.length < expectedShards && !red.length) return null;
  const worst = ['gone', 'aborted'].find((state) => list.some((r) => r.state === state));
  const failed = red[0] || list.find((r) => r.state !== 'succeeded');
  const joined = require('./unit-suite').joinUnitShardOutputs(list);
  const state = red.length ? (red.some((r) => r.state === 'timeout') ? 'timeout' : 'failed')
    : (worst || (failed ? 'failed' : 'succeeded'));
  return {
    state,
    stdout: joined.stdout,
    stderr: joined.stderr,
    timedOut: list.some((r) => r.timedOut),
    exitCode: failed ? failed.exitCode : 0,
  };
}

// A preview machine's checks run whose claim was lost (its process died, or
// its lease ran out), collected by the retry of the same work item rather
// than run again (src/workflow/preview/services.ts checks.run): the Jobs its
// manifest names, read to the end and settled in collect mode, so the
// settlement is returned for the machine to store. Null when there is
// nothing to read (no launched manifest, a Job gone, a blocking unit suite
// that cannot be read): the retry then runs the checks again. Throws the
// signal's reason when the work item is cancelled meanwhile, and throws when
// whether the unit suite blocks merges cannot be read: the item is retried
// and reads the Jobs again. Never settled as advisory on that doubt (#4996,
// #4973).
async function collectForWorkflow(config, pool, { runKey, session, app, signal }) {
  const visuals = require('./visuals');
  const kubernetes = require('./kubernetes');
  const unitSuite = require('./unit-suite');
  const checkHistory = require('./check-history');
  const appManifest = require('./app-manifest');
  if (!isEnabled(config)) return null;
  // The newest claim of the run that launched its Jobs.
  const { rows: [row] } = await pool.query(
    `SELECT run_id, session_id, commit_sha, manifest, started_at FROM check_runs
      WHERE session_id = $1 AND manifest->>'runKey' = $2 AND manifest->>'launched' = 'true'
      ORDER BY started_at DESC LIMIT 1`, [session.id, runKey]);
  const manifest = row?.manifest || {};
  if (!row || manifest.workflow !== true) return null;
  const runId = row.run_id;
  const sessionId = Number(session.id);
  const commitSha = row.commit_sha || null;
  const jobs = await kubernetes.findCheckJobs(config, { sessionId, previewRunId: runId });
  // The early unit suite (preview services checks.unitEarly) has its own run
  // id, which the manifest names when the run went to read it. A run that
  // found it unreadable launched its own under the claim's id: those, when
  // there are any, are the suite.
  const ownUnit = (Array.isArray(jobs.unitSuites) && jobs.unitSuites.length) || jobs.unitSuite;
  const unitFrom = manifest.unitRunId && !ownUnit
    ? await kubernetes.findCheckJobs(config, { sessionId, previewRunId: manifest.unitRunId }) : jobs;
  const unitJobs = Array.isArray(unitFrom.unitSuites) && unitFrom.unitSuites.length
    ? unitFrom.unitSuites : (unitFrom.unitSuite ? [unitFrom.unitSuite] : []);
  const captureJobs = Array.isArray(jobs.captures) ? jobs.captures : (jobs.capture ? [jobs.capture] : []);
  const captureExpected = !(manifest.shotsOnly && !manifest.media);
  if (captureExpected && captureJobs.length < (Number(manifest.captureShards) || 1)) return null;
  const unitTracker = unitSuite.makeUnitSuiteTracker(await unitSuite.loadExpectedTests(pool, app.id));
  const [capture, unit] = await Promise.all([
    captureJobs.length ? Promise.all(captureJobs.map((job) => kubernetes.collectCheckJob(config, {
      name: job.name, kind: 'capture',
      timeoutMs: visuals.RUN_TIMEOUT_MS + DEADLINE_SLACK_MS, maxBuffer: visuals.RUN_MAX_BUFFER, signal,
    }))).then(joinCaptures) : Promise.resolve(null),
    unitJobs.length ? Promise.all(unitJobs.map((job) => kubernetes.collectCheckJob(config, {
      name: job.name, kind: 'unit-suite',
      timeoutMs: unitSuite.UNIT_SUITE_TIMEOUT_MS + DEADLINE_SLACK_MS, maxBuffer: unitSuite.UNIT_SUITE_MAX_BUFFER,
      onStdoutLine: (line) => {
        if (unitJobs.length > 1 && /^# (tests|pass|fail|skipped|cancelled|todo) /.test(line)) return;
        unitTracker.feed(line);
      },
      signal,
    }))).then((results) => joinUnitResults(results, Number(unitFrom.unitShards) || 1)) : Promise.resolve(null),
  ]);
  if (signal?.aborted) throw signal.reason;
  if (capture && (capture.state === 'gone' || capture.state === 'aborted')) return null;
  const graduated = (await checkHistory.loadGraduated(pool, app.id, { sessionId, strict: true }))
    .has(appManifest.checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH));
  let unitOutcome = null;
  if (unit && (unit.state === 'succeeded' || unit.state === 'failed' || unit.state === 'timeout')) {
    unitOutcome = await unitSuite.outcomeFromLog({
      pool, appId: app.id, sessionId, succeeded: unit.state === 'succeeded',
      stdout: unit.stdout, stderr: unit.stderr, timedOut: unit.timedOut || unit.state === 'timeout',
      exitCode: unit.exitCode, graduated, tracker: unitTracker,
    });
  }
  // A suite that blocks merges and cannot be read is one only a fresh run
  // can judge.
  if (!unitOutcome && !manifest.shotsOnly && graduated) return null;
  // A capture Job that wrote nothing at all, or that its deadline did not
  // end, says nothing about the proposal. It is the
  // platform's fault, and spends none of the proposal's automatic retries.
  if (capture && ((capture.state === 'failed' && !capture.stdout.trim()) || capture.state === 'timeout')) {
    const why = capture.state === 'timeout'
      ? 'capture Job still running past its deadline'
      : `capture Job failed${capture.stderr ? ` (${capture.stderr})` : ''}`;
    kubernetes.deleteSettledCheckJobs(config, { sessionId, previewRunId: runId }).catch(() => {});
    await checkRuns.finish(pool, runId);
    return { outcome: 'blocked', reason: why.slice(0, 300), platformFault: true };
  }
  const settled = await visuals.settleCaptureRun(config, pool, {
    session, app, commitHash: commitSha,
    runStartedAt: Number(manifest.startedAt) || Date.parse(row.started_at) || Date.now(),
    shotsOnly: !!manifest.shotsOnly, admissionReason: manifest.admissionReason || null,
    media: !!manifest.media, legacyMediaSuppressed: manifest.legacyMediaSuppressed === true,
    capturePaths: Array.isArray(manifest.capturePaths) && manifest.capturePaths.length ? manifest.capturePaths : ['/'],
    pathDefaulted: !!manifest.pathDefaulted, captureRouteSource: manifest.captureRouteSource || null,
    visualScenarios: Array.isArray(manifest.visualScenarios) ? manifest.visualScenarios : [],
    prodRunning: !!manifest.prodRunning, stagingOrigin: manifest.stagingOrigin || '',
    targets: Array.isArray(manifest.targets) ? manifest.targets : [],
    testsCount: Number(manifest.testsCount) || 0,
    dispatched: Array.isArray(manifest.dispatched) ? manifest.dispatched : null,
    ceilingDropped: Number(manifest.ceilingDropped) || 0,
    stdout: capture ? capture.stdout : '', stderr: capture ? (capture.stderr || '') : '',
    runPartial: capture ? !!capture.partial : false, runPartialReason: capture ? (capture.partialReason || '') : '',
    // The shards whose test Pod never started: the platform's fault, as on a
    // live run (check-pod-start.js).
    notStarted: capture?.notStarted || [],
    unitOutcome, collect: { runId: runKey },
  });
  // Read out: the Jobs and the row go, as a live run's do once it settles.
  kubernetes.deleteSettledCheckJobs(config, { sessionId, previewRunId: runId }).catch(() => {});
  if (manifest.unitRunId) kubernetes.deleteSettledCheckJobs(config, { sessionId, previewRunId: manifest.unitRunId }).catch(() => {});
  await checkRuns.finish(pool, runId);
  return settled.result;
}

// The runs of the session whose manifest names `commitSha`: whoever reads
// them, their verdict is one the row still takes. What stopSupersededRuns
// spares.
async function runsOfCommit(pool, sessionId, commitSha) {
  const { rows } = await pool.query(
    'SELECT run_id, commit_sha FROM check_runs WHERE session_id = $1', [Number(sessionId)]
  );
  return new Set(rows.filter((row) => (row.commit_sha || null) === (commitSha || null)).map((row) => row.run_id));
}

// A run starting for a session supersedes the session's runs for any other
// commit. storeChecks writes only the verdict for the commit the row is
// pending on, so nobody reads what their Jobs produce, and under load those
// Jobs hold the capacity the new run needs. captureForSession calls this
// once its manifest is written, before its own Jobs exist. A run for the
// same commit is left alone: its verdict is still one the row takes, from
// its own work item or from that item's retry. A running Job whose manifest
// is gone belongs to a run that already ended without reading it, and is
// stopped too. Never throws.
async function stopSupersededRuns(config, pool, { sessionId, runId, commitSha }) {
  if (!isEnabled(config) || !sessionId || !runId) return [];
  try {
    const current = await runsOfCommit(pool, sessionId, commitSha);
    current.add(runId);
    const stopped = await require('./kubernetes').stopCheckJobs(config, {
      sessionId: Number(sessionId), spare: (id) => current.has(id),
    });
    if (stopped.length) {
      log.info('check-harvest', 'Stopped the Jobs of runs a newer run superseded', {
        sessionId: Number(sessionId), runId, commitSha: commitSha || null, stopped,
      });
    }
    return stopped;
  } catch (err) {
    log.warn('check-harvest', 'Could not stop superseded check Jobs (non-fatal)', {
      sessionId: Number(sessionId), runId, err: err.message,
    });
    return [];
  }
}

module.exports = {
  collectForWorkflow,
  isEnabled,
  runsOfCommit,
  stopSupersededRuns,
  // Exported for tests.
  joinCaptures,
  joinUnitResults,
};
