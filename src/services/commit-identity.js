'use strict';

// Who the commits Homeroom makes itself are by: one identity, from here, for
// every one of them. A hosted coding turn's, the Homeroom bot's fix rounds
// included (services/worker.js, through the worker's GIT_* environment), the
// spec's starting screens (spec-screens-start.js), a merge or a revert on
// the git host (native-merge.js, hosted-git.js), a fork or a first commit
// (app-forker.js, git-host.js), the platform's own git work on a submitted
// head (external-agent-head.js) and a revert on the platform's GitHub
// repository (routes/votes.js createRevertPR).
//
// Until 26 Oct 2026 they were authored as usernode-bot, under its GitHub
// noreply address (LEGACY_EMAIL below). GitHub suspended that account on
// 25 Oct (services/github.js, "Who Homeroom is on GitHub"); its noreply
// address attributes a commit to it on GitHub and names nobody of ours on
// the git host, so nothing is committed under it any more. Commits made
// before keep it forever, which is why recognition (homeroomCommitterEmails,
// services/homeroom-commits.js) still accepts it.
//
// A commit uploaded from someone's own agent is the one exception, on
// purpose: it is committed as 'Homeroom CLI' <cli@usernodelabs.org>
// (github.js, hosted-git.js createProposalCommit), which says it was written
// on that person's machine.
//
// The platform's environment may override it (neither is set by the Helm
// chart, so the defaults are the identity):
//   GIT_HOST_COMMIT_NAME   the name (default `Homeroom`)
//   GIT_HOST_COMMIT_EMAIL  the address (default
//                          homeroom@users.noreply.onhomeroom.com)
// A worker gets it from the platform (worker.js), never from its own image.
//
// Pure: reads only the environment it is given.

const DEFAULT_NAME = 'Homeroom';
const DEFAULT_EMAIL = 'homeroom@users.noreply.onhomeroom.com';

// Recognition only, never written: the address Homeroom's commits carried
// before 26 Oct 2026. tests/commit-identity.test.js fails if it is written as
// a commit identity anywhere in src/ or worker/.
const LEGACY_EMAIL = 'usernode-bot@users.noreply.github.com';

/** Who Homeroom's own commits are by: { name, email }. */
function homeroomAuthor(env = process.env) {
  return {
    name: (env && env.GIT_HOST_COMMIT_NAME) || DEFAULT_NAME,
    email: (env && env.GIT_HOST_COMMIT_EMAIL) || DEFAULT_EMAIL,
  };
}

/** The same identity as git's environment, author and committer alike. */
function gitIdentityEnv(author = homeroomAuthor()) {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

/** The same identity as `git -c` arguments, for one git command. */
function gitConfigArgs(author = homeroomAuthor()) {
  return ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`];
}

/**
 * Every address a commit Homeroom made itself may carry, lower-cased: the
 * configured one, the default, and the one from before 26 Oct 2026.
 */
function homeroomCommitterEmails(env = process.env) {
  return [...new Set([homeroomAuthor(env).email, DEFAULT_EMAIL, LEGACY_EMAIL]
    .map((e) => String(e).trim().toLowerCase()))];
}

module.exports = {
  DEFAULT_NAME,
  DEFAULT_EMAIL,
  LEGACY_EMAIL,
  homeroomAuthor,
  gitIdentityEnv,
  gitConfigArgs,
  homeroomCommitterEmails,
};
