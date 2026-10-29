'use strict';

// What the git-host flows' platform operations share
// (services/platform-operations.js, "git-host flows"): a version's suggestion
// to its original (suggest-back-operation.js), its updates down
// (upstream-operation.js), the App bench studio's reference builds
// (bench-reference-operation.js) and demo mode's proposals
// (demo-operation.js). Each route keeps its checks and refusals and answers
// as it always did; a conductor makes the writes, each kept as a step.
//
//   patchPayload(patch) / patchOf(payload)
//       a submitted patch as its request's large input: base64, since JSONB
//       holds no NUL character, and back to the same string;
//   appliedStep(steps, key, apply, { owner, repo, head })
//       external-agent-patch.applyPatch's answer kept as a step, so a retry
//       never pushes the branch twice. A step keeps JSON, not the broom the
//       answer carries (`cleanup`, which removes the pushed branch), so when
//       an earlier attempt kept it the broom is made again from its branch;
//   stopped(steps, err)
//       whether a failure is the work no longer being this process's: the
//       next process carries on from the steps, so nothing is given back;
//   refused(res, out) / answered(out)
//       a route's answer from the operation's: a refusal's own body and
//       status (an operation's run answers { ok: false, status, body }, the
//       shape its route answered with), the platform's own when there is no
//       body, and a run that failed for good as the throw it replaces
//       ("Internal server error"); a success without the request's id.

const log = require('./logger');
const durableSteps = require('./durable-steps');

function patchPayload(patch) {
  return { patchB64: Buffer.from(String(patch ?? ''), 'utf8').toString('base64') };
}

function patchOf(payload) {
  return payload && typeof payload.patchB64 === 'string'
    ? Buffer.from(payload.patchB64, 'base64').toString('utf8') : null;
}

function stopped(steps, err) {
  return !!(steps && steps.stopped) || durableSteps.isStopped(err);
}

// The branch an apply pushed, removed from the app's repository with the
// same credential the apply used (external-agent-head.deleteBranch, which
// logs and never throws).
async function discardBranch({ owner, repo, branch, head = require('./external-agent-head') }) {
  if (!branch) return;
  let credential;
  try {
    credential = await head.resolveWriteCredential(owner);
  } catch (err) {
    log.warn('git-host-flows', 'Could not remove a pushed branch', { owner, repo, branch, err: err.message });
    return;
  }
  await head.deleteBranch({ owner, repo, branch, credential });
}

async function appliedStep(steps, key, apply, { owner, repo, head } = {}) {
  const attempt = await steps.once(key + '-target', () => ({
    newBranch: 'usernode/patch-op-' + require('node:crypto').randomBytes(12).toString('hex'),
    commitDate: new Date().toISOString(),
  }));
  let broom = null;
  const kept = await steps.once(key, async () => {
    const out = await apply(attempt);
    if (out && out.ok && typeof out.cleanup === 'function') broom = out.cleanup;
    const { cleanup: _cleanup, ...rest } = out || {};
    return rest;
  });
  const cleanup = broom
    || (kept && kept.ok && kept.branch ? () => discardBranch({ owner, repo, branch: kept.branch, ...(head ? { head } : {}) })
      : async () => {});
  return { ...kept, cleanup };
}

// A lost create response can become pr_exists inside the host's own retry.
// Look up the kept branch both before and after creation; an unreadable
// outcome retains the branch and lets the operation retry.
async function openPr(gh, owner, repo, input) {
  const find = async () => {
    try { return await gh.findOpenPrByBranch(owner, repo, input.branch); }
    catch (err) { err.prOutcomeUnknown = true; throw err; }
  };
  const existing = await find();
  if (existing) return existing;
  try { return await gh.createPR(owner, repo, input); }
  catch (err) {
    if (durableSteps.isStopped(err)) throw err;
    const made = await find();
    if (made) return made;
    throw err;
  }
}
function permanentPrRefusal(err) {
  return !err.prOutcomeUnknown && err.code !== 'pr_exists' && [400, 422].includes(err.status);
}

function refused(res, out) {
  if (out && out.body && typeof out.body === 'object') return res.status(out.status || 500).json(out.body);
  const status = (out && out.status) || 500;
  if (status === 500 && !(out && out.code)) return res.status(500).json({ error: 'Internal server error' });
  const { ok: _ok, status: _status, ...rest } = out;
  return res.status(status).json(rest);
}

function answered(out) {
  const { ok: _ok, requestId: _requestId, ...rest } = out || {};
  return rest;
}

module.exports = { patchPayload, patchOf, stopped, discardBranch, appliedStep, openPr, permanentPrRefusal, refused, answered };
