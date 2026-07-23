'use strict';

// #687 — in-memory mock GitHub source for the PR-import flow.
//
// Consulted only in STAGING previews (callers pick the client via
// `usesMockGithubForImports()` in config.js, i.e. USERNODE_ENV ===
// 'staging'). Staging previews of the platform have no GitHub credentials
// (the GITHUB_* secrets are private), so the mock is what makes the
// import → head-change → merge-409 flow exercisable there. Production
// always uses the real services/github.js client.
//
// It exposes the exact subset of the github.js surface the imported-PR
// consumers touch — isEnabled / listOpenPulls / getPR / listChangedFiles /
// mergePR / getOctokit — so the routes, the sync poller, and the merge path
// can swap it in with a one-line client selection. Backed by a small
// in-memory catalog + a per-process head-revision map, so a reviewer can
// drive the full create → head-change (tally reset + re-review) → merge-409
// flow in a preview with no real GitHub credentials.
//
// Determinism note: state (the head-revision map) lives in-process and is
// advanced only by an explicit bumpHead() call (the mock-control route). At
// boot every PR is at revision 0, so background sweeps see an unchanged head
// and no-op — the seeded fixtures stay static until a reviewer bumps them.

const log = require('./logger');

// Reuse the real head-moved sentinel so checkAndMerge's `err.headMoved`
// branch treats a mock refusal identically to a real GitHub 409. Fall back
// to a local class if github.js can't be loaded (keeps this module usable in
// isolation / tests that stub github).
let HeadMovedError;
try {
  ({ HeadMovedError } = require('./github'));
} catch (_) { /* fall through to local */ }
if (!HeadMovedError) {
  HeadMovedError = class HeadMovedError extends Error {
    constructor(message) {
      super(message || 'PR head moved since the reviewed commit');
      this.name = 'HeadMovedError';
      this.headMoved = true;
    }
  };
}

// Deterministic 40-char hex-ish sha from (prNumber, revision).
function mockHeadSha(prNumber, rev = 0) {
  const base = `mock${prNumber}rev${rev}`;
  return (base + '0'.repeat(40)).slice(0, 40);
}

// Seeded-fixture heads (see src/db/migrate.js seedStagingImportedPrProposal).
// Registering them here means a mock-mode sweep computes the SAME head the
// fixture stored, so it reports 'unchanged' and never spuriously resets a
// seeded row before a reviewer explicitly bumps it.
const FIXTURE_HEADS = {
  9310: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
  9311: 'f0e9d8c7b6a5049382716f5e4d3c2b1a09f8e7d6',
};

// Importable candidates surfaced by listOpenPulls (not tied to any DB row
// until a reviewer imports one). Kept obviously-fake per staging conventions.
const CANDIDATES = [
  { number: 9401, title: '[Mock] Importable PR — add a dashboard widget', author: 'octo-mock', headRef: 'mock/importable-widget', baseRef: 'main' },
  { number: 9402, title: '[Mock] Importable PR — fix a typo in the footer', author: 'octo-mock', headRef: 'mock/importable-typo', baseRef: 'main' },
];

// prNumber -> integer revision. Absent = revision 0.
const _rev = new Map();

function currentRev(prNumber) {
  return _rev.get(Number(prNumber)) || 0;
}

// Advance a PR's head one revision — the "author pushed a new commit"
// simulation. Returns the new head sha.
function bumpHead(prNumber) {
  const n = Number(prNumber);
  _rev.set(n, currentRev(n) + 1);
  const head = currentHead(n);
  log.info('github-mock', 'Simulated head push', { prNumber: n, rev: currentRev(n), head });
  return head;
}

function currentHead(prNumber) {
  const n = Number(prNumber);
  const rev = currentRev(n);
  if (rev === 0 && FIXTURE_HEADS[n]) return FIXTURE_HEADS[n];
  return mockHeadSha(n, rev);
}

// Reset all in-memory revision state (used by tests for isolation).
function _resetForTests() {
  _rev.clear();
}

function isEnabled() {
  return true;
}

function metaFor(prNumber) {
  const n = Number(prNumber);
  const c = CANDIDATES.find((x) => x.number === n);
  return {
    number: n,
    title: c ? c.title : `[Mock] Imported PR #${n}`,
    headRef: c ? c.headRef : `mock/pr-${n}`,
    baseRef: c ? c.baseRef : 'main',
    author: c ? c.author : 'octo-mock',
  };
}

async function listOpenPulls(/* owner, repo */) {
  return CANDIDATES.map((c) => ({
    number: c.number,
    title: c.title,
    user: { login: c.author },
    head: { ref: c.headRef, sha: currentHead(c.number) },
    base: { ref: c.baseRef },
    state: 'open',
    html_url: `https://example.com/mock/pull/${c.number}`,
  }));
}

async function getPR(owner, repo, prNumber) {
  const m = metaFor(prNumber);
  return {
    number: m.number,
    title: m.title,
    state: 'open',
    merged: false,
    user: { login: m.author },
    head: { ref: m.headRef, sha: currentHead(prNumber) },
    base: { ref: m.baseRef },
    // Always cleanly mergeable in the mock (real conflict simulation is out
    // of scope — the flow being exercised is head-change + exact-sha merge).
    mergeable: true,
    mergeable_state: 'clean',
    html_url: `https://example.com/mock/pull/${m.number}`,
  };
}

async function listChangedFiles(/* owner, repo, basehead */) {
  return ['public/index.html', 'src/routes/example.js', 'README.md'];
}

// Exact-sha merge, mirroring the real mergePR (Slice 4): when `sha` is pinned
// and no longer matches the current head (a reviewer bumped it since the
// vote), refuse with a HeadMovedError — the same sentinel a real GitHub 409
// raises — so checkAndMerge's head-moved branch fires. Otherwise "merge".
async function mergePR(owner, repo, prNumber, sha = null) {
  const head = currentHead(prNumber);
  if (sha && sha !== head) {
    log.info('github-mock', 'Mock merge refused — head moved', { prNumber, pinnedSha: sha, head });
    throw new HeadMovedError(`mock: PR #${prNumber} head is ${head}, tried to merge ${sha}`);
  }
  const mergeSha = mockHeadSha(Number(prNumber) + 500000, currentRev(prNumber));
  log.info('github-mock', 'Mock PR merged', { prNumber, mergeSha });
  return { sha: mergeSha, merged: true, message: 'mock merge' };
}

// Minimal octokit shim so pr-import-sync.refreshDriftState (which calls
// getOctokit(...).rest.repos.compareCommits) works in mock mode: report the
// branch as up to date (behind_by 0), so drift refresh is a clean no-op.
async function getOctokit(/* owner */) {
  return {
    rest: {
      repos: {
        compareCommits: async () => ({ data: { behind_by: 0, ahead_by: 1, status: 'ahead' } }),
      },
    },
  };
}

module.exports = {
  isEnabled,
  listOpenPulls,
  getPR,
  listChangedFiles,
  mergePR,
  getOctokit,
  HeadMovedError,
  // mock-control + fixtures alignment
  bumpHead,
  currentHead,
  mockHeadSha,
  CANDIDATES,
  _resetForTests,
};
