'use strict';

// Whether a `#N` in free text is written as a pull request's rather than a
// request's: "PR #12", "pull request #12", "proposal #6011", "Change #6002"
// (a change is named by its pull request number, change-destination.js).
//
// While requests and pull requests shared GitHub's one counter, reading such
// a number as a request only found nothing. Homeroom numbers its requests
// itself now (services/app-numbers.js), and on a project still on GitHub the
// pull requests take the same numbers, so it can find an unrelated request:
// a brief that mentioned "PR #6048" was told to link open request 6048, a
// legal request somebody else was doing, which the merge would have closed
// (30 Oct 2026). Readers of `#N` (the connector's mentioned requests, the
// Homeroom bot's requestNumbers) skip these.
//
// `text` is the whole text and `index` where the `#` (or the character just
// before it) starts.
const LABELLED_AS_PULL_REQUEST = /\b(?:pr|pull request|proposal|change)\s*$/;

function labelledAsPullRequest(text, index) {
  const before = String(text || '').slice(Math.max(0, index - 16), index).toLowerCase();
  return LABELLED_AS_PULL_REQUEST.test(before);
}

module.exports = { labelledAsPullRequest };
