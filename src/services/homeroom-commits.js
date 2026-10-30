'use strict';

// What a native change's head move was, read from the commits it added
// (routes/votes.js reconcileNativeReviewedHead), so the line in the change's
// thread and its description's freshness come from the push itself and not
// from which of a dozen callers happened to reconcile it first. Run four
// (13 Oct 2026): a fix round of the bot's read "was updated on GitHub.
// Earlier votes were cleared, so please re-review commit 3f2a…" and marked
// the description "Written for an earlier version of this change."
//
// WHO. Every commit Homeroom writes is committed under one of its own
// identities: Homeroom's one identity (services/commit-identity.js) for a
// hosted coding turn's, the Homeroom bot's included (services/worker.js),
// and the platform's own git work (external-agent-head.js,
// external-agent-patch.js); and 'Homeroom CLI' for a commit uploaded from
// someone's own agent (github.js, hosted-git.js). A person pushing to the
// branch commits as themselves, or as GitHub for an edit made on its website.
//
// Recognition accepts the address commits carried before 26 Oct 2026 as well
// (usernode-bot's, commit-identity.js LEGACY_EMAIL): those commits keep it
// forever, and a move that adds one is still Homeroom's.
//
// WHAT. The bot's fix rounds commit with the fixed messages below
// (homeroom-bot.js runChecksFix, homeroom-bot-live.js reviewLanded): a fix of
// its own red checks, of what its shots showed broken, the sample data its
// shots need, a review round's fixes. Each changes how the change works,
// never what it does, so the description written before it still describes
// it. A round whose agent committed under its own message is not recognised,
// and reads as any other update did.
//
// Pure, but for the configured identity (GIT_HOST_COMMIT_EMAIL), read when
// a move is classified.

const commitIdentity = require('./commit-identity');

// Homeroom's identity by default, the one from before 26 Oct 2026
// (recognition only: commits made then keep it), and the CLI upload's.
const HOMEROOM_COMMITTERS = Object.freeze([
  commitIdentity.DEFAULT_EMAIL,
  commitIdentity.LEGACY_EMAIL,
  'cli@usernodelabs.org',
]);

/** Whether `email` is an address Homeroom commits under, now or before. */
function isHomeroomCommitter(email, env = process.env) {
  const e = String(email || '').trim().toLowerCase();
  return !!e && (HOMEROOM_COMMITTERS.includes(e) || commitIdentity.homeroomCommitterEmails(env).includes(e));
}

// The bot's commits name a request as "request N", never `#N`. On GitHub `#N`
// is GitHub's own number, and its pull requests take the numbers Homeroom's
// requests hold (pr-metadata.js closingLine), so "Homeroom bot: #6050 …"
// linked an unrelated pull request from main's history (30 Oct 2026).

/** The bot's build commit, at most 120 characters: the change, then its request. */
function buildCommitMessage(issueNumber, title) {
  const tail = ` (request ${issueNumber})`;
  return `Homeroom bot: ${String(title || '').trim()}`.slice(0, 120 - tail.length).trimEnd() + tail;
}

/** The messages the bot's fix rounds commit with. */
const FIX_COMMIT_MESSAGES = Object.freeze({
  checks: (issueNumber) => `Homeroom bot: fix the failing checks on request ${issueNumber}`,
  broken: (issueNumber) => `Homeroom bot: fix what did not work on request ${issueNumber}`,
  shots: (issueNumber) => `Homeroom bot: seed what the before and after shots of request ${issueNumber} need`,
  review: (round) => `Homeroom bot: review fixes, round ${round}`,
});

// A fix round committed before 30 Oct 2026 said `#N`, and is still one.
const FIX_SUBJECT = /^Homeroom bot: (?:fix the failing checks on (?:#|request )\d+|fix what did not work on (?:#|request )\d+|seed what the before and after shots of (?:#|request )\d+ need|review fixes, round \d+)$/;

/**
 * What the commits a move added say about it: `madeByHomeroom` when Homeroom
 * committed every one, `fixOnly` when every one is also a fix round's.
 * `commits` is [{ committer, subject }] (repo-mirror.js commitsBetween), or
 * null when they could not be read, which says neither.
 */
function classify(commits) {
  if (!Array.isArray(commits) || !commits.length) return { madeByHomeroom: false, fixOnly: false };
  const madeByHomeroom = commits.every((c) => isHomeroomCommitter(c && c.committer));
  const fixOnly = madeByHomeroom && commits.every((c) => FIX_SUBJECT.test(String(c && c.subject || '').trim()));
  return { madeByHomeroom, fixOnly };
}

module.exports = { HOMEROOM_COMMITTERS, FIX_COMMIT_MESSAGES, FIX_SUBJECT, buildCommitMessage, isHomeroomCommitter, classify };
