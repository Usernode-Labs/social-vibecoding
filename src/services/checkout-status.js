'use strict';

// #1433 — the drift check behind the connector's `get_checkout_status`.
//
// ── The failure this exists to catch ───────────────────────────────────
//
// A coding agent working in a checkout it did not create cannot tell that
// the checkout is a stale fork, because the check it naturally reaches for
// returns a FALSE PASS:
//
//     git fetch origin main && git rev-list --count HEAD...origin/main
//     -> 0
//
// `origin` is the fork. The fork's `main` really is current — with itself.
// The observed instance ran a design review against a checkout 92 pull
// requests behind the live platform, over a week in which an entire UI
// overhaul had shipped (211 changed files under frontend/src alone, three
// feature directories added and one removed), and reported its conclusions
// with confidence. Nothing in the checkout was wrong; nothing in it was
// current either, and nothing in it said so.
//
// ── Why it takes two parties ───────────────────────────────────────────
//
// Neither side can answer this alone. The platform knows which repository
// an app is canonically built from and where its default branch points; it
// cannot see the caller's working copy. The caller knows its own HEAD and
// its own remote; it cannot know which repository is canonical, because a
// fork's `origin` is a perfectly ordinary-looking GitHub URL.
//
// So the model is handed both halves and asked to compare — the same
// derivation `whoami` already uses for the connector-name spelling problem
// (#1218), and for the same reason: the party that can see both halves is
// the only one that can do the comparison.
//
// ── Why the answer carries `baseToUse` ─────────────────────────────────
//
// Detection on its own would leave the agent to invent a remedy, and the
// obvious one — merge or reset to the canonical default branch — is exactly
// what it must not do on its own initiative. Which commit a proposal is
// diffed against decides what the group is voting on, so it is the work
// order's call (services/external-agent-tasks.js pins `base_sha`), not the
// agent's. This returns the commit rather than the instruction, and the
// verdict copy points at prepare_work for anything about to be built.
//
// Everything here is READ-ONLY and advisory. It writes nothing, claims
// nothing, and a GitHub hiccup degrades the answer rather than failing the
// caller's turn.

// A caller passes whatever `git rev-parse HEAD` printed. Accept an
// abbreviated sha too — `git rev-parse --short HEAD` is just as likely to be
// what is to hand, and GitHub's compare endpoint resolves either.
const SHA_RE = /^[0-9a-f]{7,40}$/;

function normalizeSha(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  return SHA_RE.test(s) ? s : null;
}

// Same-repository test, on owner/repo rather than on the URL string: the
// four URL shapes parseGithubUrl accepts (https, https/, https.git, ssh) all
// name the same repository, and a caller pasting the output of
// `git remote get-url origin` may hand back any of them.
function sameRepo(a, b) {
  if (!a || !b) return null;
  return a.owner.toLowerCase() === b.owner.toLowerCase()
    && a.repo.toLowerCase() === b.repo.toLowerCase();
}

/**
 * Compare a caller's checkout against an app's canonical repository.
 *
 * `deps.gh` is services/github.js (injected so this is testable without a
 * GitHub installation). `repoUrl` is the app's canonical repository as the
 * platform records it; `headSha` and `remoteUrl` are what only the caller
 * can see.
 *
 * Never throws for an ordinary "cannot tell" — an unreachable GitHub or an
 * unknown commit comes back as a verdict, because a drift check that fails
 * the turn is worse than one that says it does not know.
 */
async function checkoutStatus(deps, params) {
  const { gh } = deps;
  const repoUrl = params.repoUrl || null;
  const remoteUrl = params.remoteUrl || null;
  const headSha = normalizeSha(params.headSha);

  if (!headSha) {
    return {
      code: 'invalid_head_sha',
      message: 'headSha must be a git commit id: 7 to 40 hexadecimal characters, '
        + 'as printed by `git rev-parse HEAD`.',
    };
  }

  const canonical = repoUrl ? gh.parseGithubUrl(repoUrl) : null;
  if (!canonical) {
    return {
      code: 'no_canonical_repo',
      message: 'This app has no GitHub repository recorded, so there is nothing '
        + 'to compare a checkout against.',
    };
  }

  // The remote comparison is pure string parsing — no API call, and it works
  // even when GitHub is unreachable below. `null` means the caller did not
  // pass a remote, which is different from "the remote is wrong".
  //
  // `=== true` rather than the bare result, because there are THREE states
  // and only two of them are a boolean. A remote that was supplied but does
  // not parse as a GitHub repository at all is definitively NOT the
  // canonical one — reporting that as `null` would say "you did not tell me"
  // about a caller who did.
  const callerRemote = remoteUrl ? gh.parseGithubUrl(remoteUrl) : null;
  const remoteIsCanonical = remoteUrl ? (sameRepo(callerRemote, canonical) === true) : null;

  const answer = {
    canonicalRepo: `https://github.com/${canonical.owner}/${canonical.repo}`,
    defaultBranch: null,
    canonicalHead: null,
    canonicalHeadCommittedAt: null,
    remoteIsCanonical,
    headSha,
    containsCommit: null,
    behindBy: null,
    aheadBy: null,
    mergeBaseSha: null,
    verdict: 'unknown',
    baseToUse: null,
    note: '',
  };

  let head;
  try {
    head = await gh.getRepoHead(canonical.owner, canonical.repo);
  } catch (err) {
    answer.verdict = 'repo_unreachable';
    answer.note = 'Could not read the canonical repository from GitHub, so this '
      + 'says nothing about whether the checkout is current. '
      + `(${err && err.message ? err.message : 'unknown error'})`;
    return answer;
  }

  answer.defaultBranch = head.defaultBranch;
  answer.canonicalHead = head.headSha;
  answer.canonicalHeadCommittedAt = head.headCommittedAt;
  answer.baseToUse = head.headSha;

  // A canonical repository with no commits on its default branch. Rare, but
  // comparing against a null base would 404 and come back as
  // `unknown_commit` — which would tell the caller their checkout is wrong
  // when the truth is that there is nothing yet to compare it to.
  if (!head.headSha) {
    answer.verdict = 'repo_unreachable';
    answer.note = `${answer.canonicalRepo} has no commits on ${head.defaultBranch}, `
      + 'so there is nothing to compare this checkout against.';
    return answer;
  }

  // An exact match settles it without spending a compare call — and it is
  // the common case for a session that was set up correctly.
  if (head.headSha && head.headSha.startsWith(headSha)) {
    answer.containsCommit = true;
    answer.behindBy = 0;
    answer.aheadBy = 0;
    answer.mergeBaseSha = head.headSha;
    answer.verdict = 'current';
    answer.note = remoteIsCanonical === false
      ? 'The checkout is at the canonical default branch\'s head, though its '
        + 'origin is a different repository (a fork). Nothing to catch up on.'
      : 'The checkout is at the canonical default branch\'s head.';
    return answer;
  }

  // base...head, so `behind_by` counts commits the canonical head has that
  // the caller's does not — which is the number the caller actually wants.
  let cmp;
  try {
    cmp = await gh.compareCommitAncestry(
      canonical.owner, canonical.repo, head.headSha, headSha
    );
  } catch (err) {
    // A 404 here is the interesting case, not an outage: GitHub answers it
    // when one side of the compare is not a commit in this repository. That
    // is a checkout built on something the canonical repository has never
    // seen — a fork with its own commits, or a different repository
    // altogether.
    const status = err && (err.status || err.statusCode);
    if (status === 404) {
      answer.containsCommit = false;
      answer.verdict = 'unknown_commit';
      answer.note = `Commit ${headSha} is not in ${answer.canonicalRepo}. `
        + 'The checkout is either built on unpushed local work or on a '
        + 'different repository. Do not diff against it: get the base commit '
        + 'from prepare_work before making changes.';
      return answer;
    }
    answer.verdict = 'repo_unreachable';
    answer.note = 'Could not compare against the canonical repository, so this '
      + 'says nothing about whether the checkout is current. '
      + `(${err && err.message ? err.message : 'unknown error'})`;
    return answer;
  }

  answer.containsCommit = true;
  answer.behindBy = cmp.behindBy;
  answer.aheadBy = cmp.aheadBy;
  answer.mergeBaseSha = cmp.mergeBaseSha;

  // Worded to cover both shapes this fires for: an actual fork, and a remote
  // that is not this repository at all.
  const forkNote = remoteIsCanonical === false
    ? ' Its origin is a different repository — a fork, most likely — so '
      + '`git fetch origin` reports it current.'
    : '';

  if (cmp.behindBy > 0 && cmp.aheadBy > 0) {
    answer.verdict = 'diverged';
    answer.note = `The checkout has ${cmp.aheadBy} commit(s) the canonical `
      + `repository does not, and is missing ${cmp.behindBy}.${forkNote} `
      + 'Get the base commit from prepare_work rather than merging anything here.';
  } else if (cmp.behindBy > 0) {
    answer.verdict = 'behind';
    answer.note = `The checkout is ${cmp.behindBy} commit(s) behind `
      + `${answer.canonicalRepo}'s ${head.defaultBranch}.${forkNote} `
      + 'Anything read from it may describe code that has since changed. '
      + 'For work that will be submitted, take the base commit from '
      + 'prepare_work rather than merging the default branch here.';
  } else if (cmp.aheadBy > 0) {
    answer.verdict = 'ahead';
    answer.note = `The checkout carries ${cmp.aheadBy} commit(s) of its own on `
      + 'top of the canonical head, which is what work in progress looks like.';
  } else {
    answer.verdict = 'current';
    answer.note = 'The checkout matches the canonical default branch.';
  }

  return answer;
}

module.exports = {
  checkoutStatus,
  _normalizeSha: normalizeSha,
  _sameRepo: sameRepo,
};
