'use strict';

// The "an agent that is not a platform worker container produced a commit —
// now finish the job" pipeline.
//
// This code used to live inside src/routes/proposal-handoff.js, where it was
// written for exactly one caller: the `proposal_*` MCP tools driving a local
// Codex/Claude session (`chat_sessions.source = 'cli_handoff'`). #907 adds a
// second caller — a local coding agent attached to an ordinary native Dev
// session (`source = 'anthropic'`) — that needs the identical tail: build the
// staging preview, persist the pointer, warm the certificate, tell any open
// web page, capture visuals.
//
// Admission, full runtime publication and failure retirement now use the
// preview-flow action owner. It preserves the native source/status policy and
// additionally rejects a result from an older retry of the SAME commit.
// Imported proposals retain their separate adapter until its policy migrates.
//
// Session ownership and staging capacity are enforced by the callers, before
// they get here.

const staging = require('./staging');
const stagingRecovery = require('./staging-recovery');
const visuals = require('./visuals');
const { beginSessionOperation } = require('./active-workers');
const log = require('./logger');

// A user can submit a newer local commit while an earlier HTTP request is
// still proving ancestry/updating GitHub. Serialize that adoption per session
// so an older request can never persist its SHA after the newer request and
// regress the durable reviewed head. This matches staging.js's process model;
// deployments run one platform process, while different sessions still move
// independently.
const handoffSubmissionTails = new Map();
const handoffPipelines = new Set();

function serializeHandoffSubmission(sessionId, fn) {
  const key = String(sessionId);
  const previous = handoffSubmissionTails.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  handoffSubmissionTails.set(key, tail);
  tail.then(() => {
    if (handoffSubmissionTails.get(key) === tail) handoffSubmissionTails.delete(key);
  });
  return run;
}

function hasInFlightHandoffPipeline(sessionId) {
  return handoffPipelines.has(String(sessionId));
}

function beginHandoffPipeline(sessionId) {
  const key = String(sessionId);
  handoffPipelines.add(key);
  const releaseOperation = beginSessionOperation(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    handoffPipelines.delete(key);
    releaseOperation();
  };
}

function startHandoffPipeline(
  config, pool, session, app, headSha, releasePipeline, trigger = 'commit-push'
) {
  const run = runStaging(config, pool, session, app, headSha, trigger);
  run.catch((err) => {
    log.error('handoff-pipeline', 'Unexpected handoff run rejection', {
      sessionId: session.id, err: err.message,
    });
  }).finally(() => {
    releasePipeline();
  });
  return run;
}

// Whether the session is still in a lifecycle state this run may publish
// into. The status it started in, or promoted ON THIS COMMIT: since #3043 a
// change can be submitted for review while its checks run, and promotion
// pins reviewed_head_sha to the commit being checked. The vote is waiting on
// exactly this run's verdict then, so promotion must not cancel it. Any
// other change (archived, merged, promoted on another commit) still does.
function publishableStatus(row, expectedStatus, headSha) {
  // Compatibility export; policy itself lives with the enabling conditions.
  return require('./preview-flow/enabling-conditions').publishableStatus(row && {
    status: row.status, reviewedHeadSha: row.reviewed_head_sha?.toLowerCase() || null,
  }, expectedStatus, String(headSha).toLowerCase());
}

async function runStaging(config, pool, session, app, headSha, trigger = 'commit-push') {
  // Explicit paused submissions are allowed; a later lifecycle change still
  // cancels this run's right to publish (see publishableStatus). Never resume
  // coding here.
  let result;
  try {
    const prepared = await require('./preview-flow/native').prepareNativePreview({
      config, pool, session, app, headSha, build: staging.buildAndDeployStaging,
    });
    if (!prepared.accepted) {
      // The receipt is historical evidence, not a public preview pointer.
      // The native consumer already cleaned under the build lock, or left its
      // durable resource intent for preview-cleanup to retry.
      log.info('handoff-pipeline', 'Discarded stale staging publication', {
        sessionId: session.id, headSha, reason: prepared.reason,
      });
      return;
    }
    result = prepared.result;
  } catch (err) {
    // A newer submission may have queued while this build was running. Its
    // pending verdict must not be overwritten by a late failure from the old
    // head.
    log.error('handoff-pipeline', 'Staging build failed', {
      sessionId: session.id, headSha, err: err.message,
    });
    if (!err.previewFlow) return; // Admission failed; no execution identity to settle.
    await stagingRecovery.recordStagingBootFailure({
      config, pool, session, commitHash: headSha, err, previewFlow: err.previewFlow,
    }).catch((recordErr) => log.warn('handoff-pipeline', 'Failed to record staging failure', {
      sessionId: session.id, err: recordErr.message,
    }));
    return;
  }

  await staging.warmStagingCert(session, result.hostname, result.stagingUrl)
    .catch((err) => log.warn('handoff-pipeline', 'Staging certificate warm failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    }));
  // The caller may have no open SSE response (the CLI handoff never does; a
  // local agent turn only does while the browser tab that started it is
  // still open), so use the global/session buses to make an optionally-open
  // web Dev page learn that its preview is live.
  try {
    // eslint-disable-next-line global-require
    const { broadcastGlobal, pushSessionUpdate } = require('./ws');
    broadcastGlobal({
      type: 'session_event', sessionId: session.id,
      event: 'staging_ready', url: result.stagingUrl,
    });
    pushSessionUpdate({
      action: 'staging_ready', sessionId: session.id, appSlug: app.slug,
    });
  } catch (err) {
    log.warn('handoff-pipeline', 'Staging-ready notify failed (non-fatal)', {
      sessionId: session.id, err: err.message,
    });
  }

  // captureForSession owns its terminal error verdict and never lets a test
  // runner failure escape. Awaiting it here keeps status honest while still
  // running entirely outside the original HTTP request.
  await visuals.captureForSession(config, session, app, headSha, result, { trigger });
  return result;
}

module.exports = {
  serializeHandoffSubmission,
  hasInFlightHandoffPipeline,
  beginHandoffPipeline,
  startHandoffPipeline,
  publishableStatus,
  runStaging,
};
