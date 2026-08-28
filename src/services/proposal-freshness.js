'use strict';

// #1442 — keep a promoted proposal's freshness numbers true while it waits.
//
// ── The failure this exists to fix ─────────────────────────────────────
//
// Proposal 3590 (PR #1431) presented itself to voters as ready to merge:
// behind main by 0, 412 of 412 checks passing, no conflict. All three were
// stale. It was eight commits behind, `git merge-tree` found ten conflicting
// hunks across seven files, and the checks had passed against a base commit
// main had long since moved past.
//
// Nothing was lying. Nothing was measuring either. Every writer of
// behind_main and merge_conflict_state fires on an event a WAITING proposal
// does not have — a worker turn, an imported-PR head change, or a merge
// attempt the gate only makes once a proposal already looks mergeable — so
// the numbers were simply whatever they had been at submission.
//
// ── The shape ──────────────────────────────────────────────────────────
//
// A refresh asks GitHub the three questions and writes the answers to the
// freshness_* columns (see schema.sql's "Proposal freshness" block), which
// are a cache, never a source of truth. Two triggers fill it: a leader-only
// sweeper pass in server.js, and a TTL-gated refresh when someone actually
// opens a proposal. Reads are pure and never call GitHub.
//
// ── Why it can never throw ─────────────────────────────────────────────
//
// This runs inside a sweeper and inside a read path a voter is waiting on.
// A GitHub hiccup must degrade the answer, not fail the caller's request or
// abort the sweep, so every failure comes back as a verdict plus a recorded
// freshness_error and the previous numbers are left alone. Same stance as
// services/checkout-status.js.
//
// ── Two kinds of staleness, deliberately kept apart ────────────────────
//
// checks.stale (mcp-tools.shapeChecks) means "the BRANCH moved since the
// checks ran" and keeps its meaning untouched. What was missing is the other
// axis: "did MAIN move out from under the base those checks ran against?"
// That is checks_base_verdict, and it needed a new column
// (checks_base_sha) because nothing anywhere recorded the base.

const log = require('./logger');

const SHA_RE = /^[0-9a-f]{7,40}$/;

// How long a freshness snapshot is treated as good enough on a read path.
// Short on purpose: this gates the on-demand refresh, and the number a voter
// reads a second before they click should be the current one. The sweeper's
// own, much longer cooldown lives in server.js.
const FRESHNESS_TTL_MS = 60 * 1000;

function normalizeSha(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return SHA_RE.test(s) ? s : null;
}

// The proposal's own head, matching mcp-tools.headShaOf: an imported PR is
// authoritative about its own head, a platform-authored session records the
// head its checks reviewed.
function headShaOf(session) {
  const s = session || {};
  const raw = String(s.source) === 'imported'
    ? s.imported_pr_head_sha
    : (s.reviewed_head_sha || s.imported_pr_head_sha);
  return normalizeSha(raw);
}

function intOrNull(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The pure read. Given a chat_sessions row (or the subset of it the votes
 * routes select), return the nested `freshness` block the API serializes and
 * the UI derives from. Calls nothing, never throws, and is safe on a row
 * that predates the columns entirely.
 *
 * `mergeability` is deliberately its own top-level value rather than living
 * inside the block: the UI's block-reason table keys off it directly, and a
 * nested read there would be a second place to get the null handling wrong.
 */
function readFreshness(session) {
  const s = session || {};
  const behind = intOrNull(s.freshness_behind_by);
  const files = Array.isArray(s.mergeability_files) ? s.mergeability_files : [];
  const mergeability = s.mergeability === 'clean' || s.mergeability === 'conflict'
    ? s.mergeability
    : (s.mergeability === 'unknown' ? 'unknown' : null);
  return {
    checkedAt: s.freshness_checked_at ? new Date(s.freshness_checked_at).toISOString() : null,
    mainSha: normalizeSha(s.freshness_main_sha),
    mergeBaseSha: normalizeSha(s.freshness_merge_base_sha),
    behindBy: behind,
    aheadBy: intOrNull(s.freshness_ahead_by),
    mergeability,
    mergeabilityFiles: files.slice(0, 50),
    mergeabilityFilesComplete: s.mergeability_files_complete == null
      ? null : !!s.mergeability_files_complete,
    checksRanOnBase: normalizeSha(s.checks_base_sha),
    checksBaseVerdict: s.checks_base_verdict || null,
    checksBaseBehindBy: intOrNull(s.checks_base_behind_by),
    error: s.freshness_error || null,
  };
}

// Is this snapshot young enough that a read path should not spend two GitHub
// calls re-taking it?
function isFresh(session, ttlMs = FRESHNESS_TTL_MS) {
  const at = session && session.freshness_checked_at;
  if (!at) return false;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return false;
  return (Date.now() - t) < Math.max(0, ttlMs);
}

// ── The refresh ────────────────────────────────────────────────────────

// Answers "is the base those checks ran on still on main's first-parent
// line?" with ONE compare call, and skips it entirely in the two cases where
// the answer is already known for free.
async function checksBaseVerdict(gh, owner, repo, baseSha, mainSha, mergeBaseSha) {
  if (!baseSha) return { verdict: 'unknown', behindBy: null };
  if (baseSha === mainSha || (mergeBaseSha && baseSha === mergeBaseSha)) {
    return { verdict: 'current', behindBy: 0 };
  }
  const cmp = await gh.compareCommitAncestry(owner, repo, baseSha, mainSha);
  // base...main: 'ahead' means main has commits the base does not but the
  // base is still an ancestor, which is exactly "still current, just older".
  // 'identical' is the same thing with nothing in between. 'behind' and
  // 'diverged' both mean main no longer contains that base.
  const contained = cmp.status === 'ahead' || cmp.status === 'identical';
  return {
    verdict: contained ? 'current' : 'superseded',
    behindBy: Number.isFinite(cmp.aheadBy) ? cmp.aheadBy : null,
  };
}

// GitHub exposes no "which files conflict" endpoint. The honest upper bound
// is the intersection of what each side changed since their common ancestor:
// a file only one side touched cannot conflict. Worth being explicit that
// this is a superset — two edits to opposite ends of the same file land in
// here and would merge fine.
async function predictConflictFiles(gh, owner, repo, mergeBaseSha, headSha, mainSha) {
  if (!mergeBaseSha) return { files: [], complete: false };
  const [ours, theirs] = await Promise.all([
    gh.compareRefs(owner, repo, `${mergeBaseSha}...${headSha}`),
    gh.compareRefs(owner, repo, `${mergeBaseSha}...${mainSha}`),
  ]);
  const mine = new Set(ours.files || []);
  const files = (theirs.files || []).filter((f) => mine.has(f)).sort();
  return { files, complete: !!(ours.filesComplete && theirs.filesComplete) };
}

/**
 * Re-measure one promoted proposal against main and write the result through.
 *
 * `deps` is `{ gh, pool }` — github.js is injected so this unit-tests without
 * a GitHub installation, the same way checkout-status.js does it.
 *
 * Returns the freshness block it wrote (the same shape readFreshness gives),
 * plus `{ skipped }` when there was nothing to measure. NEVER throws.
 */
async function refreshFreshness(deps, session, options = {}) {
  const { gh, pool } = deps || {};
  const s = session || {};
  const answer = readFreshness(s);

  const repoUrl = s.repo_url || null;
  const parsed = repoUrl && gh ? gh.parseGithubUrl(repoUrl) : null;
  const headSha = headShaOf(s);
  const prNumber = parseInt(s.pr_number, 10);

  if (!pool || !gh || !parsed || !headSha) {
    return { ...answer, skipped: 'incomplete_session' };
  }
  if (!options.force && isFresh(s, options.ttlMs)) {
    return { ...answer, skipped: 'fresh' };
  }

  const { owner, repo } = parsed;
  const next = {
    mainSha: null,
    mergeBaseSha: null,
    behindBy: null,
    aheadBy: null,
    mergeability: null,
    files: [],
    filesComplete: null,
    baseVerdict: 'unknown',
    baseBehindBy: null,
    error: null,
  };

  try {
    // Never a hardcoded 'main': getRepoHead reads the repository's own
    // default branch, which is the branch a merge would actually target.
    const head = await gh.getRepoHead(owner, repo);
    const mainSha = normalizeSha(head && head.headSha);
    if (!mainSha) throw new Error(`${owner}/${repo} has no commits on its default branch`);
    next.mainSha = mainSha;

    const cmp = await gh.compareCommitAncestry(owner, repo, mainSha, headSha);
    next.behindBy = Number.isFinite(cmp.behindBy) ? cmp.behindBy : null;
    next.aheadBy = Number.isFinite(cmp.aheadBy) ? cmp.aheadBy : null;
    next.mergeBaseSha = normalizeSha(cmp.mergeBaseSha);

    // GitHub computes mergeability lazily and answers `null` until it has.
    // A null must NEVER overwrite a known 'conflict' — the whole point of
    // this pass is to stop a proposal reverting to looking clean.
    if (Number.isFinite(prNumber) && prNumber > 0) {
      try {
        const pr = await gh.getPR(owner, repo, prNumber);
        const m = pr ? pr.mergeable : undefined;
        if (m === true) next.mergeability = 'clean';
        else if (m === false) next.mergeability = 'conflict';
        else next.mergeability = s.mergeability === 'conflict' ? 'conflict' : 'unknown';
      } catch (err) {
        next.mergeability = s.mergeability === 'conflict' ? 'conflict' : 'unknown';
        log.debug('freshness', 'getPR failed', { sessionId: s.id, err: err.message });
      }
    } else {
      next.mergeability = 'unknown';
    }

    // Only spend the two file compares when there is a conflict to locate.
    if (next.mergeability === 'conflict') {
      try {
        const pred = await predictConflictFiles(gh, owner, repo, next.mergeBaseSha, headSha, mainSha);
        next.files = pred.files;
        next.filesComplete = pred.complete;
      } catch (err) {
        next.files = [];
        next.filesComplete = null;
        log.debug('freshness', 'conflict-file prediction failed', { sessionId: s.id, err: err.message });
      }
    } else {
      next.files = [];
      next.filesComplete = null;
    }

    try {
      const verdict = await checksBaseVerdict(
        gh, owner, repo, normalizeSha(s.checks_base_sha), mainSha, next.mergeBaseSha
      );
      next.baseVerdict = verdict.verdict;
      next.baseBehindBy = verdict.behindBy;
    } catch (err) {
      next.baseVerdict = 'unknown';
      next.baseBehindBy = null;
      log.debug('freshness', 'checks-base compare failed', { sessionId: s.id, err: err.message });
    }
  } catch (err) {
    // The outer failure: GitHub is unreachable, or the head is not a commit
    // this repository has ever seen. Record why, keep the previous numbers,
    // and stamp checked_at so the sweeper does not spin on this row.
    next.error = err && err.message ? String(err.message).slice(0, 300) : 'unknown error';
    try {
      await pool.query(
        `UPDATE chat_sessions
            SET freshness_checked_at = NOW(), freshness_error = $2
          WHERE id = $1`,
        [s.id, next.error]
      );
    } catch (e) {
      log.warn('freshness', 'error stamp failed', { sessionId: s.id, err: e.message });
    }
    return { ...answer, checkedAt: new Date().toISOString(), error: next.error };
  }

  // One write. behind_main is written THROUGH so the merge gate — which
  // still reads that single column and nothing here — stops being stale.
  try {
    await pool.query(
      `UPDATE chat_sessions
          SET freshness_main_sha = $2,
              freshness_merge_base_sha = $3,
              freshness_behind_by = $4,
              freshness_ahead_by = $5,
              mergeability = $6,
              mergeability_files = $7::jsonb,
              mergeability_files_complete = $8,
              checks_base_verdict = $9,
              checks_base_behind_by = $10,
              freshness_checked_at = NOW(),
              freshness_error = NULL,
              behind_main = COALESCE($4, behind_main)
        WHERE id = $1`,
      [
        s.id, next.mainSha, next.mergeBaseSha, next.behindBy, next.aheadBy,
        next.mergeability, JSON.stringify(next.files), next.filesComplete,
        next.baseVerdict, next.baseBehindBy,
      ]
    );
  } catch (err) {
    log.warn('freshness', 'write failed', { sessionId: s.id, err: err.message });
    return { ...answer, error: err.message };
  }

  const written = readFreshness({
    ...s,
    freshness_checked_at: new Date(),
    freshness_main_sha: next.mainSha,
    freshness_merge_base_sha: next.mergeBaseSha,
    freshness_behind_by: next.behindBy,
    freshness_ahead_by: next.aheadBy,
    mergeability: next.mergeability,
    mergeability_files: next.files,
    mergeability_files_complete: next.filesComplete,
    checks_base_verdict: next.baseVerdict,
    checks_base_behind_by: next.baseBehindBy,
    freshness_error: null,
  });

  // Same session_update channel the sync banner already uses, so an open
  // proposal screen re-derives its notes without a reload.
  try {
    const { pushSessionUpdate } = require('./ws');
    pushSessionUpdate({
      action: 'freshness',
      sessionId: s.id,
      appSlug: s.app_slug || null,
      behindMain: next.behindBy == null ? undefined : Math.max(0, next.behindBy),
      freshness: written,
    });
  } catch (_) { /* ws failures are non-fatal */ }

  return written;
}

// Read paths can be concurrent — several voters opening the same proposal, or
// a poll landing on top of a click. One in-flight refresh per session is
// plenty; the rest wait on it rather than each spending their own GitHub
// calls. Process-local by design: the sweeper is leader-only and the TTL
// bounds how much duplicate work a multi-instance deployment can do.
const inFlight = new Map();

function refreshFreshnessDeduped(deps, session, options = {}) {
  const id = session && session.id;
  if (id == null) return refreshFreshness(deps, session, options);
  const existing = inFlight.get(id);
  if (existing) return existing;
  const p = refreshFreshness(deps, session, options)
    .catch((err) => {
      // refreshFreshness does not throw; this is belt-and-braces so a bug in
      // it can never reject a voter's page load.
      log.warn('freshness', 'unexpected rejection', { sessionId: id, err: err && err.message });
      return readFreshness(session);
    })
    .finally(() => { inFlight.delete(id); });
  inFlight.set(id, p);
  return p;
}

module.exports = {
  refreshFreshness,
  refreshFreshnessDeduped,
  readFreshness,
  isFresh,
  FRESHNESS_TTL_MS,
  _normalizeSha: normalizeSha,
  _headShaOf: headShaOf,
  _checksBaseVerdict: checksBaseVerdict,
  _predictConflictFiles: predictConflictFiles,
  _inFlight: inFlight,
};
