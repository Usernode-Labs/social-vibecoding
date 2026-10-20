'use strict';

// The "an agent that is not a platform worker container produced a commit —
// now finish the job" pipeline.
//
// This code used to live inside src/routes/proposal-handoff.js, where it was
// written for exactly one caller: the `proposal_*` MCP tools driving a local
// Codex/Claude session (`chat_sessions.source = 'cli_handoff'`). #907 adds a
// second caller — a local coding agent attached to an ordinary native Dev
// session (`source = 'anthropic'`) — that needs the identical tail: the
// submitted commit handed to the preview machine, which builds and checks it.
//
// The row guard (OWNED_SOURCE_SQL) is the callers': `source IS DISTINCT FROM
// 'imported'`. An imported PR is a mirror of someone else's GitHub branch —
// the platform does not own its head and must never stage over it; every
// other source is a session whose commits the platform produced or adopted.
//
// Session ownership and staging capacity are enforced by the callers, before
// they get here.

const { beginSessionOperation } = require('./active-workers');
const log = require('./logger');

// Written into every guard below. Kept as one constant so the "which sessions
// may the platform stage over" rule has exactly one definition.
const OWNED_SOURCE_SQL = "source IS DISTINCT FROM 'imported'";

// A user can submit a newer local commit while an earlier HTTP request is
// still proving ancestry/updating GitHub. Serialize that adoption per session
// so an older request can never persist its SHA after the newer request and
// regress the durable reviewed head. This matches staging.js's process model;
// different sessions still move independently. A pipeline is counted for this
// process's drain (services/processes.js); another process sees its recorded
// operation (beginHandoffPipeline).
const handoffSubmissionTails = new Map();
const handoffPipelines = require('./processes').heldSet('handoff');

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

// A hand-off pipeline this process runs on the session. One another process
// runs is the session's recorded operation (kind 'handoff-pipeline'), read
// from the database: session-work.ts operationOfKindLiveSql.
function hasInFlightHandoffPipeline(sessionId) {
  return handoffPipelines.has(String(sessionId));
}

function beginHandoffPipeline(sessionId) {
  const key = String(sessionId);
  handoffPipelines.add(key);
  // Its own kind: a promote of the very commit it checks does not wait for
  // it (src/workflow/proposal/facts.ts).
  const releaseOperation = beginSessionOperation(sessionId, 'handoff-pipeline');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    handoffPipelines.delete(key);
    releaseOperation();
  };
}

// The preview machine builds and checks the submitted upload; its pin
// (handoff_head_sha) refuses a stale one.
function startHandoffPipeline(
  config, pool, session, app, headSha, releasePipeline, trigger = 'commit-push'
) {
  const run = require('./preview-workflow').revision({ pool, session, head: headSha, source: 'cli', trigger });
  run.catch((err) => {
    log.error('handoff-pipeline', 'Unexpected handoff run rejection', {
      sessionId: session.id, err: err.message,
    });
  }).finally(() => {
    releasePipeline();
  });
  return run;
}

module.exports = {
  OWNED_SOURCE_SQL,
  serializeHandoffSubmission,
  hasInFlightHandoffPipeline,
  beginHandoffPipeline,
  startHandoffPipeline,
};
