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

// Pin the source before a write. On retry, the target can prove that the
// write landed even when its checkpoint did not; never substitute a newer
// source revision. A transport still verifies the fetched commit before push.
async function forkStep(steps, key, { gh, owner, repo, targetBranch, source, verify, push, adopt }) {
  if (steps.has(key)) return steps.once(key, () => null);
  let fresh;
  const pinned = source || await steps.once(key + '-source', async () => (fresh = await verify()));
  if (!pinned.ok) return pinned;
  return steps.once(key, async () => {
    const recover = async () => {
      let current = null;
      try { current = await gh.getBranchSha(owner, repo, targetBranch); }
      catch (err) { if (err.status !== 404) throw err; }
      return String(current).toLowerCase() === pinned.headSha
        ? (adopt ? adopt(pinned.headSha) : { ok: true, headSha: pinned.headSha, branch: targetBranch }) : null;
    };
    if (steps.resumed) {
      const landed = await recover();
      if (landed) return landed;
    }
    if (verify) {
      fresh ||= await verify();
      if (!fresh.ok) return fresh;
      if (fresh.headSha !== pinned.headSha) return require('./external-agent-head').sourceMoved(fresh.headSha);
    }
    const out = await push(pinned.headSha, fresh || pinned);
    return out?.code === 'platform_unavailable' ? await recover() || out : out;
  });
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
    || (kept && kept.ok && kept.branch ? () => (head || require('./external-agent-head')).removeBranch({ owner, repo, branch: kept.branch })
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

module.exports = { patchPayload, patchOf, stopped, forkStep, appliedStep, openPr, permanentPrRefusal, refused, answered };
