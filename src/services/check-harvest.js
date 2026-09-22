'use strict';

// Settle checks runs whose launching process died.
//
// A platform rollout replaces every platform Pod, and every merge to the
// self-app is a rollout. A checks run in flight at that moment loses the
// process that was streaming its capture and unit-suite Jobs — but the Jobs
// themselves are the cluster's, not the Pod's, and they run to completion
// regardless. Before this module the verdict they produced went nowhere: the
// row stayed 'pending' until the stale sweeper (CHECKS_STALE_MS, ten
// minutes) noticed and started the whole suite over on a fresh preview.
// #2125 paid that four times in half an hour, once with a 490-check suite
// three-quarters done.
//
// The harvester reads the run instead of repeating it. Every run records a
// manifest in check_runs before its Jobs exist (services/check-runs.js) and
// heartbeats it while they run; a row nobody has heartbeated for the orphan
// window is a run whose owner is gone. For each such row:
//
//   * the session is re-read — a row whose checks have since been decided,
//     whose head has moved on, or whose lifecycle names a newer run, is
//     moot and its manifest is simply cleared;
//   * the run's Jobs are found by the preview-run-id label. A finished Job
//     is read; a running one is waited on with its progress re-published to
//     the card (the bar keeps moving across the hand-over); a missing one
//     — never created, already collected, or cancelled by a successor that
//     the checks above did not see — means a re-drive, immediately;
//   * the output goes through visuals.settleCaptureRun: the same parse,
//     verdict, stores and broadcasts a live run ends with, under the same
//     commit guards. Under the preview lifecycle the run's operation row is
//     adopted first (preview-lifecycle.adopt), so every write carries the
//     ownership check a live run's does and a successor aborts the harvest
//     rather than the other way round.
//
// Runs on the leader: once at boot, before the stale sweep (so a run that
// can be harvested never reads as stuck), then on a timer. A sweep is
// single-flight and bounded; a harvest holds the session's in-flight seat
// (visuals.holdCapture) so every other surface sees it as the run it is.

const log = require('./logger');
const checkRuns = require('./check-runs');
const { getPool } = require('../db/pool');

const SWEEP_MS = Math.max(5000, Number(process.env.CHECK_HARVEST_SWEEP_MS) || 30_000);
const MAX_CONCURRENT = Math.max(1, Number(process.env.CHECK_HARVEST_CONCURRENCY) || 3);
// Slack past the Jobs' own activeDeadlineSeconds before a still-running Job
// is given up on — the cluster should have ended it by then.
const DEADLINE_SLACK_MS = 30_000;

// Statuses whose checks still matter. Mirrors the scope of the stale
// sweeper (staging-recovery.isStuckCheckRecoveryScope): promoted rows, and
// active CLI hand-offs whose head is being judged.
const LIVE_STATUSES = new Set(['promoted', 'active', 'paused', 'merging']);

const harvesting = new Map(); // sessionId → runId
let sweeping = null;

function isEnabled(config) {
  return (config?.captureRuntime || process.env.CAPTURE_RUNTIME) === 'kubernetes';
}

function isHarvesting(sessionId) {
  return harvesting.has(Number(sessionId));
}

async function loadSession(pool, sessionId) {
  const { rows } = await pool.query(
    `SELECT cs.*, a.slug AS app_slug, a.name AS app_name, a.repo_url,
            a.runtime_name AS app_runtime_name, a.runtime_kind AS app_runtime_kind
       FROM chat_sessions cs JOIN apps a ON a.id = cs.app_id
      WHERE cs.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

// Whether the run the manifest describes is still the run the session is
// waiting on. Anything else — decided meanwhile, head moved, session closed
// — makes the manifest moot: nothing to settle, nothing to re-drive.
function stillCurrent(session, commitSha) {
  if (!session) return { current: false, why: 'session gone' };
  if (!LIVE_STATUSES.has(session.status)) return { current: false, why: `session ${session.status}` };
  if (session.check_state !== 'pending') return { current: false, why: `checks ${session.check_state || 'unset'}` };
  // A shots-only run's settlement is its deferral stamp (check_state stays
  // 'pending', check_phase becomes 'deferred'); a manifest outliving that
  // stamp has already been settled.
  if (session.check_phase === 'deferred') return { current: false, why: 'checks deferred' };
  if ((session.checks_commit_sha || null) !== (commitSha || null)) return { current: false, why: 'head moved' };
  return { current: true, why: '' };
}

function describeRow(row, reason) {
  const manifest = row.manifest || {};
  return {
    sessionId: Number(row.session_id), runId: row.run_id, commitSha: row.commit_sha || null,
    reason, trigger: manifest.trigger || null,
  };
}

// Phase one of adoption: take the row and the session's in-flight seat.
// Two writes and no cluster reads, so a sweep can seat every orphan before
// anything slower looks at those sessions — the boot stale sweep above all,
// which would otherwise read a harvestable run as stuck and start it over.
// Returns { hold } to carry into adopt(), or a terminal { outcome } when
// another harvester took the row first ('contested') or a live run already
// has the session ('busy' — it will settle the head itself).
async function claimRun(pool, row, base) {
  const visuals = require('./visuals');
  const lifecycle = require('./preview-lifecycle');
  if (!(await checkRuns.claim(pool, base.runId, row.owner))) return { outcome: 'contested', ...base };
  const stopHeartbeat = checkRuns.startHeartbeat(pool, base.runId);
  const controller = new AbortController();
  const release = visuals.holdCapture(base.sessionId, base.commitSha, {
    abort: (why) => { if (!controller.signal.aborted) controller.abort(why || lifecycle.cancelled()); },
  });
  if (!release) {
    stopHeartbeat();
    return { outcome: 'busy', ...base };
  }
  harvesting.set(base.sessionId, base.runId);
  return { hold: { stopHeartbeat, controller, release } };
}

// One orphaned row, start to finish. Returns { outcome, ... } for the sweep's
// log line: 'settled' (a verdict was stored from the Job's output), 'redriven'
// (nothing readable — a fresh run was requested), 'moot' (the session no
// longer wants this run), 'busy' (a live run here has the session),
// 'contested' (another harvester took the row first), or 'failed'.
// `hold` is the seat claimRun() took; without one the claim happens here.
async function adopt(config, pool, row, { reason = 'sweep', hold = null } = {}) {
  const visuals = require('./visuals');
  const kubernetes = require('./kubernetes');
  const unitSuite = require('./unit-suite');
  const checkHistory = require('./check-history');
  const appManifest = require('./app-manifest');
  const lifecycle = require('./preview-lifecycle');
  const mergeDebug = require('./merge-debug');
  const stagingRecovery = require('./staging-recovery');

  const sessionId = Number(row.session_id);
  const runId = row.run_id;
  const manifest = row.manifest || {};
  const commitSha = row.commit_sha || null;
  const startedAt = Date.now();
  const base = describeRow(row, reason);

  if (!hold) {
    const taken = await claimRun(pool, row, base);
    if (!taken.hold) return taken;
    hold = taken.hold;
  }
  const { stopHeartbeat, controller, release } = hold;

  let operation = null;
  let verdict = null;
  // The lifecycle row can still name the dead run as `running` before the
  // harvest adopts it (or when adoption declines). Closing it through a
  // stub keeps teardown() from reading the dead run as busy; settleAdopted
  // touches the row only while it still carries this run id, so a
  // successor's row is never overwritten.
  const settleLifecycle = async (outcome) => {
    if (!lifecycle.enabled(config)) return;
    await lifecycle.settleAdopted(config, operation || { sessionId, runId }, outcome).catch(() => {});
  };
  const moot = async (why) => {
    log.info('check-harvest', 'Orphaned run is moot — clearing its manifest', { ...base, why });
    await checkRuns.finish(pool, runId);
    await settleLifecycle({ error: lifecycle.cancelled() });
    return { outcome: 'moot', why, ...base };
  };
  const redrive = async (session, why) => {
    log.info('check-harvest', 'Orphaned run has nothing to read — re-driving its checks now', { ...base, why });
    await checkRuns.finish(pool, runId);
    await settleLifecycle({ error: new Error(why) });
    mergeDebug.endRun(pool, manifest.debugRunId || null, {
      status: 'error', summary: `checks run orphaned (${why}); re-driven`,
    });
    // Release the seat BEFORE the re-drive so captureForSession does not
    // park itself behind the harvest that is asking for it.
    release(null);
    await stagingRecovery.recheckSessionChecks({ config, pool, session, reason: 'orphaned-run' });
    return { outcome: 'redriven', why, ...base };
  };

  try {
    const session = await loadSession(pool, sessionId);
    const currency = stillCurrent(session, commitSha);
    if (!currency.current) return await moot(currency.why);
    const app = {
      id: session.app_id, slug: session.app_slug, name: session.app_name, repo_url: session.repo_url,
      runtime_name: session.app_runtime_name, runtime_kind: session.app_runtime_kind,
    };
    if (!manifest.launched) return await redrive(session, 'process died before the Jobs were created');

    // Under the lifecycle the run's operation row must still be ours to
    // settle; a newer run's row means a successor already owns the session
    // and will settle (or has settled) it.
    if (lifecycle.enabled(config)) {
      operation = await lifecycle.adopt(config, { sessionId, runId, revision: commitSha });
      if (!operation) return await moot('lifecycle names another run');
      operation.signal.addEventListener('abort', () => {
        if (!controller.signal.aborted) controller.abort(operation.signal.reason);
      }, { once: true });
    }

    const jobs = await kubernetes.findCheckJobs(config, { sessionId, previewRunId: runId });
    // A deferred verdict on a range with no frontend files launches no
    // capture container at all (visuals: shotsOnly && !media) — its stamp is
    // the whole settlement, and there is nothing on the cluster to find.
    const captureExpected = !(manifest.shotsOnly && !manifest.media);
    if (captureExpected && !jobs.capture) return await redrive(session, 'capture Job not found');

    log.info('check-harvest', 'Adopting an orphaned checks run', {
      ...base, owner: row.owner,
      capture: jobs.capture ? jobs.capture.state : 'none',
      unitSuite: jobs.unitSuite ? jobs.unitSuite.state : 'none',
      tests: Number(manifest.testsCount) || 0,
    });

    // Progress for the card while a still-running Job is waited on. The
    // frames are re-read from the start of the log, so the counts pick up
    // where the dead process's did and go on from there.
    const trigger = manifest.trigger || 'boot-reconcile';
    const progress = visuals.makeChecksProgressState({
      expected: Number(manifest.testsCount) || 0,
      build: manifest.build || null,
      flush: async (snap) => {
        if (controller.signal.aborted) return;
        try { await visuals.setChecksProgress(pool, sessionId, commitSha, snap); } catch { return; }
        visuals.notifyChecksProgress(sessionId, commitSha, snap, 'testing', trigger);
      },
    });
    const unitTracker = unitSuite.makeUnitSuiteTracker(await unitSuite.loadExpectedTests(pool, app.id));
    let capture = null;
    let unit = null;
    try {
      [capture, unit] = await Promise.all([
        jobs.capture ? kubernetes.collectCheckJob(config, {
          name: jobs.capture.name, kind: 'capture',
          timeoutMs: visuals.RUN_TIMEOUT_MS + DEADLINE_SLACK_MS, maxBuffer: visuals.RUN_MAX_BUFFER,
          onStdoutLine: progress.observeCapture, signal: controller.signal,
        }) : Promise.resolve(null),
        jobs.unitSuite ? kubernetes.collectCheckJob(config, {
          name: jobs.unitSuite.name, kind: 'unit-suite',
          timeoutMs: unitSuite.UNIT_SUITE_TIMEOUT_MS + DEADLINE_SLACK_MS, maxBuffer: unitSuite.UNIT_SUITE_MAX_BUFFER,
          onStdoutLine: (line) => { if (unitTracker.feed(line)) progress.observeUnit(unitTracker.snapshot()); },
          signal: controller.signal,
        }) : Promise.resolve(null),
      ]);
    } finally {
      progress.close();
    }
    if (controller.signal.aborted) return await moot('superseded while collecting');
    if (capture && (capture.state === 'gone' || capture.state === 'aborted')) {
      // The Job vanished under us. A successor that cancelled it would have
      // moved the session on; if it has not, the TTL collected the Job and
      // its output with it, and only a fresh run can judge this head.
      const again = stillCurrent(await loadSession(pool, sessionId), commitSha);
      if (!again.current) return await moot(again.why);
      return await redrive(session, 'capture Job gone before it could be read');
    }

    // The unit-suite row, from the Job's own verdict. Graduation is read
    // now rather than from the manifest: the history could only have moved
    // towards graduated, and that is what a fresh run would see too. A Job
    // that vanished contributes no row — the same as a runner that failed
    // to launch in a live run.
    let unitOutcome = null;
    if (unit && (unit.state === 'succeeded' || unit.state === 'failed')) {
      let graduated = false;
      try {
        graduated = (await checkHistory.loadGraduated(pool, app.id))
          .has(appManifest.checkKey(unitSuite.UNIT_CHECK_NAME, unitSuite.UNIT_CHECK_PATH));
      } catch (err) {
        log.warn('check-harvest', 'Graduation lookup failed — unit row advisory', { ...base, err: err.message });
      }
      unitOutcome = await unitSuite.outcomeFromLog({
        pool, appId: app.id, sessionId,
        succeeded: unit.state === 'succeeded',
        stdout: unit.stdout, stderr: unit.stderr, timedOut: unit.timedOut,
        graduated, tracker: unitTracker,
      });
    }

    // A capture Job that failed without a frame to salvage, or one the
    // cluster never ended, is a run that could not judge — the live path
    // records 'error' for that (fail-closed, "couldn't run", retried by the
    // stale sweeper's error lane), and so does this.
    const unreadable = capture && ((capture.state === 'failed' && !capture.stdout.trim()) || capture.state === 'timeout');
    if (unreadable) {
      const why = capture.state === 'timeout'
        ? 'capture Job still running past its deadline'
        : `capture Job failed${capture.stderr ? ` (${capture.stderr})` : ''}`;
      log.warn('check-harvest', 'Orphaned run produced nothing to judge — recording an error verdict', { ...base, why });
      const writePool = operation ? operation.pool : pool;
      await visuals.storeCaptureOutcome(writePool, sessionId, 'failed', { reason: why.slice(0, 300) }).catch(() => {});
      const stored = await visuals.storeChecks(writePool, sessionId, commitSha, { state: 'error', results: [] }, why);
      if (stored) visuals.notifyChecks(sessionId, { state: 'error', results: [] }, commitSha, null);
      // A live capture schedules evidence from its finally block. This run's
      // launcher is gone, so the harvester must perform that hand-off itself.
      // Evidence uses its own exact-revision pair and can still succeed when
      // the legacy capture Job produced no usable output.
      visuals.scheduleVisualEvidence(config, pool, sessionId, commitSha, 'checks-harvested');
      verdict = 'error';
      mergeDebug.endRun(pool, manifest.debugRunId || null, {
        status: 'error', summary: `checks error in ${Math.round((Date.now() - (manifest.startedAt || startedAt)) / 1000)}s (harvested: ${why})`,
      });
      if (operation) await lifecycle.settleAdopted(config, operation, { result: { state: 'error' } });
      await checkRuns.finish(pool, runId);
      return { outcome: 'settled', state: 'error', why, ...base };
    }

    const traceStep = (phase, message, detail) => mergeDebug.step(pool, manifest.debugRunId || null, { phase, message, detail });
    traceStep('harvest', 'Run adopted after its process died', {
      owner: row.owner, reason, capture: capture ? capture.state : 'none', unitSuite: unit ? unit.state : 'none',
    });
    const settled = await visuals.settleCaptureRun(config, operation ? operation.pool : pool, {
      session, app, commitHash: commitSha, trigger, send: null, operation, traceStep,
      runStartedAt: Number(manifest.startedAt) || Date.parse(row.started_at) || startedAt,
      shotsOnly: !!manifest.shotsOnly, admissionReason: manifest.admissionReason || null,
      media: !!manifest.media,
      capturePaths: Array.isArray(manifest.capturePaths) && manifest.capturePaths.length
        ? manifest.capturePaths : ['/'],
      pathDefaulted: !!manifest.pathDefaulted,
      captureRouteSource: manifest.captureRouteSource || null,
      visualScenarios: Array.isArray(manifest.visualScenarios) ? manifest.visualScenarios : [],
      prodRunning: !!manifest.prodRunning,
      stagingOrigin: manifest.stagingOrigin || '',
      targets: Array.isArray(manifest.targets) ? manifest.targets : [],
      testsCount: Number(manifest.testsCount) || 0,
      dispatched: Array.isArray(manifest.dispatched) ? manifest.dispatched : null,
      ceilingDropped: Number(manifest.ceilingDropped) || 0,
      stdout: capture ? capture.stdout : '',
      stderr: capture ? (capture.stderr || '') : '',
      runPartial: capture ? !!capture.partial : false,
      runPartialReason: capture ? (capture.partialReason || '') : '',
      unitOutcome,
    });
    verdict = settled.traceStatus;
    // The live capture's finally block does not run after adoption. Without
    // this call a successfully harvested proposal keeps its evidence claim in
    // "planned" forever even though checks and screenshots have settled.
    visuals.scheduleVisualEvidence(config, pool, sessionId, commitSha, 'checks-harvested');
    mergeDebug.endRun(pool, manifest.debugRunId || null, {
      status: verdict,
      summary: `checks ${verdict} in ${Math.round((Date.now() - (Number(manifest.startedAt) || startedAt)) / 1000)}s (harvested)`,
    });
    if (operation) {
      await lifecycle.settleAdopted(config, operation, { result: settled.result });
      // The lifecycle wrapper fires this for a live run once its operation
      // completes (captureForSession skips it while one is in scope).
      visuals.maybeAutoMergeAfterChecks(config, pool, session, settled.result.state);
    }
    await checkRuns.finish(pool, runId);
    log.info('check-harvest', 'Orphaned run settled from its Jobs', {
      ...base, state: settled.result.state, durationMs: Date.now() - startedAt,
    });
    return { outcome: 'settled', state: settled.result.state, ...base };
  } catch (err) {
    if (lifecycle.isCancelled(err) || controller.signal.aborted) {
      return await moot('superseded').catch(() => ({ outcome: 'moot', why: 'superseded', ...base }));
    }
    log.warn('check-harvest', 'Harvest failed (non-fatal); the stale sweep keeps the row', { ...base, err: err.message });
    if (operation) await lifecycle.settleAdopted(config, operation, { error: err }).catch(() => {});
    return { outcome: 'failed', err: err.message, ...base };
  } finally {
    stopHeartbeat();
    harvesting.delete(sessionId);
    operation?.release?.();
    release(verdict);
  }
}

// One pass over every orphaned manifest, in two phases. The claims run
// inline — every orphan is seated (claimRun) before the returned promise
// settles, so a caller that sequences the stale sweep after this one is
// guaranteed to find those sessions in flight. The reads run detached with
// bounded concurrency: a still-running Job is waited on for as long as its
// deadline allows, and boot must not wait on that. `done` resolves to every
// row's outcome once the reads finish; pass `wait: true` to await it here.
//
// The claim phase is single-flight: a boot sweep and a timer tick that
// overlap share one pass rather than racing the same rows through the CAS.
// Detached reads exclude their sessions from the next listing (isHarvesting)
// and hold the seat, so a later pass never re-adopts a run in progress.
async function sweep(config, { reason = 'sweep', pool = null, wait = false } = {}) {
  if (!isEnabled(config)) return { skipped: true, reason: 'not kubernetes', done: Promise.resolve([]) };
  if (!sweeping) {
    sweeping = (async () => {
      const db = pool || getPool(config);
      const visuals = require('./visuals');
      let rows;
      try {
        rows = await checkRuns.listOrphans(db, {
          isInFlight: (id) => visuals.hasInFlightCapture(id) || isHarvesting(id),
        });
      } catch (err) {
        log.warn('check-harvest', 'Could not list orphaned runs (non-fatal)', { reason, err: err.message });
        return { error: err.message, orphans: 0, claimed: 0, done: Promise.resolve([]) };
      }
      if (!rows.length) return { orphans: 0, claimed: 0, done: Promise.resolve([]) };
      log.info('check-harvest', 'Orphaned checks runs found', {
        reason, count: rows.length, sessions: rows.map((r) => Number(r.session_id)),
      });

      const results = [];
      const claimed = [];
      for (const row of rows) {
        const base = describeRow(row, reason);
        try {
          const taken = await claimRun(db, row, base);
          if (taken.hold) claimed.push({ row, hold: taken.hold });
          else results.push(taken);
        } catch (err) {
          results.push({ outcome: 'failed', err: err.message, ...base });
        }
      }

      const queue = claimed.slice();
      const workers = Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, async () => {
        while (queue.length) {
          const { row, hold } = queue.shift();
          try {
            results.push(await adopt(config, db, row, { reason, hold }));
          } catch (err) {
            // adopt() releases its own seat in `finally`; this is only
            // reachable if that threw too, so drop the seat by hand.
            try { hold.stopHeartbeat(); hold.release(null); } catch { /* released */ }
            harvesting.delete(Number(row.session_id));
            results.push({ outcome: 'failed', err: err.message, ...describeRow(row, reason) });
          }
        }
      });
      const done = Promise.all(workers).then(() => {
        const tally = {};
        for (const r of results) tally[r.outcome] = (tally[r.outcome] || 0) + 1;
        log.info('check-harvest', 'Harvest sweep finished', { reason, orphans: rows.length, ...tally });
        return results;
      });
      return { orphans: rows.length, claimed: claimed.length, done };
    })().finally(() => { sweeping = null; });
  }
  const summary = await sweeping;
  if (wait) await summary.done;
  return summary;
}

// Leader-only ticker. Returns the stop function.
function start(config, { intervalMs = SWEEP_MS } = {}) {
  if (!isEnabled(config)) return () => {};
  const timer = setInterval(() => {
    sweep(config, { reason: 'tick' }).catch((err) => {
      log.warn('check-harvest', 'Harvest tick failed (non-fatal)', { err: err.message });
    });
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  SWEEP_MS,
  isEnabled,
  isHarvesting,
  sweep,
  adopt,
  start,
  // Exported for tests.
  stillCurrent,
  loadSession,
};
