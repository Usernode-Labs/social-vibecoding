'use strict';

// The preview machine (src/workflow/preview/), as the preview sources reach
// it. Every source of a preview or a checks run hands its request here;
// nothing else builds, captures, writes a verdict or tears down a preview:
// the machine decides and does the work.

const log = require('./logger');

const platform = () => require('../workflow/platform.ts');
const SHA = /^[0-9a-f]{40}$/;
const exact = (v) => (SHA.test(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);

// The machine holds the session (not retired).
async function held(sessionId) {
  return platform().previewHeld(Number(sessionId));
}

// What a source that names no exact head means (P-A1): the row's pin for its
// kind, else what its checks are pinned to, else the branch's tip.
async function exactHead(pool, session, head = null) {
  const given = exact(head);
  if (given) return given;
  const pinned = session.source === 'imported' ? exact(session.imported_pr_head_sha)
    : ['promoted', 'merging'].includes(session.status) ? exact(session.reviewed_head_sha)
      : session.source === 'cli_handoff' ? exact(session.handoff_head_sha) : null;
  if (pinned) return pinned;
  let repoUrl = session.repo_url;
  if (!repoUrl && pool) {
    const { rows } = await pool.query('SELECT repo_url FROM apps WHERE id = $1', [session.app_id]);
    repoUrl = rows[0]?.repo_url;
  }
  const [, owner, repo] = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/.]+)/) || [];
  if (owner && repo && session.branch_name) {
    const tip = exact(await require('./github').getBranchSha(owner, repo, session.branch_name).catch(() => null));
    if (tip) return tip;
  }
  return exact(session.checks_commit_sha);
}

// A source announces a head. A source whose head cannot be resolved hands
// nothing (and nothing is built). Resolves the machine's outcome
// ({ status: 'rejected', reason } when it is not taken: `same_head` for a head
// it already builds or serves), or { status: 'rejected', reason: 'no_head' }.
async function revision({ pool, session, head = null, source, trigger = null, carryFrom = null }) {
  const resolved = await exactHead(pool, session, head);
  if (!resolved) {
    log.warn('preview-workflow', 'No exact head to preview; nothing handed off', { sessionId: session.id, source });
    return { status: 'rejected', reason: 'no_head' };
  }
  return platform().submitRevision({ sessionId: Number(session.id), appId: Number(session.app_id), head: resolved, source, trigger,
    carryFrom: exact(carryFrom) });
}

// The preview itself (Preview click, deploy, a stale environment). Resolves
// the machine's outcome: its reply carries { state, head, url, verdict }.
async function request({ pool, session, head = null, reason, actor = null }) {
  const resolved = await exactHead(pool, session, head);
  if (!resolved) return { status: 'rejected', reason: 'no_head' };
  return platform().requestPreview({ sessionId: Number(session.id), appId: Number(session.app_id), head: resolved, reason, actor });
}

// Run the checks again. A session the machine does not hold yet is enrolled
// first with the head its checks are about (staging-recovery.recheckHeadSha:
// a promoted proposal's reviewed head, never a pin a run of an earlier commit
// left), read from the row now: the caller's copy can predate a promote.
async function recheck({ pool, session, reason, trigger = null, actor = null, system = false }) {
  const instance = await held(session.id) ? await platform().previewInstance(Number(session.id)) : null;
  if (!instance?.data?.head) {
    const { rows: [pins] } = await pool.query(
      `SELECT status, source, reviewed_head_sha, imported_pr_head_sha, checks_commit_sha, handoff_head_sha
         FROM chat_sessions WHERE id = $1`, [session.id]);
    const current = { ...session, ...(pins || {}) };
    await revision({ pool, session: current, head: require('./staging-recovery').recheckHeadSha(current),
      source: 'recheck', trigger });
  }
  return platform().requestRecheck({
    sessionId: Number(session.id), appId: Number(session.app_id), reason, trigger, actor, system,
  });
}

// Nothing to test: the head has no commits beyond main.
async function skipped({ session, head, reason }) {
  const resolved = exact(head) || exact(session.checks_commit_sha);
  if (!resolved) return false;
  await platform().checksSkipped(Number(session.id), Number(session.app_id), resolved, reason,
    exact(session.checks_commit_sha));
  return true;
}

// The branch's code is no longer what the verdict describes (a CLI upload
// not submitted yet, an update to a paused proposal): the machine clears the
// verdict (adopting a session it does not hold yet).
async function clear({ session, reason }) {
  await platform().checksCleared(Number(session.id), Number(session.app_id), reason);
}

// Retire a session's preview: terminal for a row that has left review
// (archived, merged, deleted), otherwise an idle or pressure reclaim.
// Answers whether the machine took it ('accepted' or 'pending'; a refusal
// says why). A preview already retired, already retiring for good, or with
// nothing serving is taken too: a second teardown of it has nothing to do.
// `retired` says the machine has applied it and the preview is retired or
// being retired: a caller about to delete the session row needs that
// (`waitMs`), because a preview the machine does not hold yet is adopted from
// the row when the request is applied. A request still pending, refused for
// another reason, or faulted is not.
const ALREADY = new Set(['retired', 'already_retiring', 'already_idle']);
async function retire({ session, reason, terminal, waitMs = undefined }) {
  const out = await platform().retirePreview(Number(session.id), Number(session.app_id), reason, !!terminal, waitMs);
  const done = out.status === 'accepted' || out.status === 'replayed'
    || (out.status === 'rejected' && ALREADY.has(out.reason));
  return { taken: done || out.status === 'pending', retired: done, status: out.status, reason: out.reason || null };
}

// An observer found the serving runtime gone: the machine rebuilds it.
async function lost({ session, detail = null }) {
  const instance = await platform().previewInstance(Number(session.id));
  const serving = instance?.data?.serving;
  if (!serving) return false;
  await platform().previewLost(Number(session.id), Number(session.app_id), serving.n, detail);
  return true;
}

// The machine is building the session's preview, retiring it, or its last
// build or checks run errored ('failed', or 'settled' on an 'error'
// verdict): a sweep that finds the preview (or the older one a failed build
// left serving) missing has nothing to add. An error runs again on the
// machine's timer while the streak is under its cap, else from the
// stuck-checks lane within the row's own cap, else when a person asks;
// never because a sweep noticed a runtime gone.
const WORKING = new Set(['preparing', 'retiring', 'failed']);
async function working(sessionId) {
  const instance = await platform().previewInstance(Number(sessionId));
  if (WORKING.has(instance?.state)) return true;
  return instance?.state === 'settled' && instance.data?.verdict === 'error';
}

module.exports = { held, working, exactHead, revision, request, recheck, skipped, clear, retire, lost };
