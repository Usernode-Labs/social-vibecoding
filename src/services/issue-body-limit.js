'use strict';

// One number for how long a request's body may be. GitHub refuses an issue
// body over 65,536 characters, and a request is a GitHub issue, so that is
// the ceiling every in-app path that files or edits one aims at (#4194: the
// feedback dialog used to stop at 2,000, so a report written on GitHub could
// not have been written here).
const GITHUB_ISSUE_BODY_MAX = 65536;

// What a person may type into the feedback dialog's description. The route
// puts a few lines of its own around it (the source and app lines, an
// offline-saved line, the screenshot and video embeds), so the description
// keeps this much of GitHub's limit free for them and a description at its
// limit always files. An app's state snapshot is fitted into what is left.
const FEEDBACK_BODY_RESERVE = 1536;
const FEEDBACK_DESCRIPTION_MAX = GITHUB_ISSUE_BODY_MAX - FEEDBACK_BODY_RESERVE;

module.exports = {
  GITHUB_ISSUE_BODY_MAX,
  FEEDBACK_BODY_RESERVE,
  FEEDBACK_DESCRIPTION_MAX,
};
