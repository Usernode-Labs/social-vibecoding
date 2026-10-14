'use strict';

// The preview machine (src/workflow/preview/), as [main]'s preview sources
// reach it. With WF_PREVIEWS_ENABLED on, every source of a preview or a
// checks run hands its request here instead of building, capturing, writing
// the verdict or tearing down itself; the machine decides and does the work.
// With the flag off, enabled() is false and the sources run as before.

const log = require('./logger');

const platform = () => require('../workflow/platform.ts');
const SHA = /^[0-9a-f]{40}$/;
const exact = (v) => (SHA.test(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null);

function enabled() {
  try { return platform().previewsEnabled(); } catch { return false; }
}

// The machine holds the session (not detached or retired).
async function held(sessionId) {
  return enabled() && platform().previewHeld(Number(sessionId));
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

// A source announces a head. Answers whether the machine took it; a source
// whose head cannot be resolved hands nothing (and builds nothing).
async function revision({ pool, session, head = null, source, trigger = null, carryFrom = null }) {
  if (!enabled()) return false;
  const resolved = await exactHead(pool, session, head);
  if (!resolved) {
    log.warn('preview-workflow', 'No exact head to preview; nothing handed off', { sessionId: session.id, source });
    return true;
  }
  await platform().submitRevision({ sessionId: Number(session.id), appId: Number(session.app_id), head: resolved, source, trigger,
    carryFrom: exact(carryFrom) });
  return true;
}

// The preview itself (Preview click, deploy, a stale environment). Resolves
// the machine's outcome: its reply carries { state, head, url, verdict }.
async function request({ pool, session, head = null, reason, actor = null }) {
  const resolved = await exactHead(pool, session, head);
  if (!resolved) return { status: 'rejected', reason: 'no_head' };
  return platform().requestPreview({ sessionId: Number(session.id), appId: Number(session.app_id), head: resolved, reason, actor });
}

// Run the checks again. A session the machine does not hold yet is enrolled
// first with its head, so the recheck has something to run against.
async function recheck({ pool, session, reason, trigger = null, actor = null, system = false }) {
  if (!await held(session.id)) {
    await revision({ pool, session, head: session.checks_commit_sha, source: 'recheck', trigger });
  }
  return platform().requestRecheck({
    sessionId: Number(session.id), appId: Number(session.app_id), reason, trigger, actor, system,
  });
}

// Nothing to test: the head has no commits beyond main.
async function skipped({ session, head, reason }) {
  const resolved = exact(head) || exact(session.checks_commit_sha);
  if (!resolved) return false;
  await platform().checksSkipped(Number(session.id), Number(session.app_id), resolved, reason);
  return true;
}

// The branch's code is no longer what the verdict describes (a CLI upload
// not submitted yet, an update to a paused proposal). For a session the
// machine holds, it clears the verdict; answers false otherwise, and the
// caller clears it itself.
async function clear({ session, reason }) {
  if (!await held(session.id)) return false;
  await platform().checksCleared(Number(session.id), Number(session.app_id), reason);
  return true;
}

// Retire a session's preview: terminal for a row that has left review
// (archived, merged, deleted), otherwise an idle or pressure reclaim.
// Answers false when the machine does not hold the session.
async function retire({ session, reason, terminal }) {
  if (!enabled()) return false;
  return platform().retirePreview(Number(session.id), Number(session.app_id), reason, !!terminal);
}

// An observer found the serving runtime gone: the machine rebuilds it.
async function lost({ session, detail = null }) {
  const instance = await platform().previewInstance(Number(session.id));
  const serving = instance?.data?.serving;
  if (!serving) return false;
  await platform().previewLost(Number(session.id), Number(session.app_id), serving.n, detail);
  return true;
}

module.exports = { enabled, held, exactHead, revision, request, recheck, skipped, clear, retire, lost };
