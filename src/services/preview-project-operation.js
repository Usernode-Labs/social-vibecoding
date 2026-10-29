'use strict';

// The preview-project operations (services/platform-operations.js): what a
// platform preview asks production for that changes the cluster, a database
// server or the git host (services/preview-projects.js), run on a conductor.
// routes/preview-projects.js keeps the door, and the web side of each step
// its checks and its claim on the project's row; the conductor makes the
// database, builds, deploys, restarts or removes.
//
// Who asks is a preview, never a person: its credential names a session, and
// the session's author stands as the requester only so the operation has one
// (anyAccount: an author without platform access is still the preview's).
// What is read again on the conductor, on every attempt, is the preview's
// own authority: projects in previews still on, and the session still a
// platform preview holding a live credential.

const previewProjects = require('./preview-projects');

const anyAccount = () => true;

async function authorize({ config, pool }, request) {
  if (!(await previewProjects.enabled(config, pool))) {
    return { status: 404, code: 'not_found', message: 'Projects cannot be made in this preview.' };
  }
  if (!(await previewProjects.liveSession(config, pool, request.input.sessionId))) {
    return { status: 401, code: 'invalid_token', message: 'That credential is not valid.' };
  }
  return null;
}

// A step refused before it ran ends as failed, so the preview's poll stops
// waiting for it.
async function abandon({ pool }, request) {
  await previewProjects.abandonRequested(pool, request);
}

async function run(deps, request) {
  const { config, pool } = deps;
  const { projectId, sessionId } = request.input;
  switch (request.op) {
    case 'previewProject.create': return previewProjects.makeDatabase(config, pool, { projectId, sessionId });
    case 'previewProject.build': return previewProjects.runRequestedBuild(config, pool, { projectId, sessionId, requestId: request.requestId });
    case 'previewProject.deploy': return previewProjects.runRequestedDeploy(config, pool, { projectId, sessionId, requestId: request.requestId });
    case 'previewProject.restart': return previewProjects.restartHere(config, pool, { projectId, sessionId });
    case 'previewProject.remove': return previewProjects.removeHere(config, pool, { projectId, sessionId });
    default: throw new Error(`Unknown preview project operation ${request.op}`);
  }
}

module.exports = { anyAccount, authorize, abandon, run };
