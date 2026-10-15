/**
 * How long a request's body may be, on the client. The server's numbers live
 * in src/services/issue-body-limit.js and src/routes/feedback.js, and
 * tests/issue-body-limit.test.js keeps these equal to them.
 *
 * #4194: the feedback dialog stopped at 2,000 characters, so a report written
 * at length on GitHub could not have been written here. A request is a GitHub
 * issue, so GitHub's own limit is the ceiling.
 */

/** GitHub's issue-body limit: the most a request's body may be edited to. */
export const ISSUE_BODY_MAX = 65536;

/**
 * The feedback dialog's description: GitHub's limit less the 1,536
 * characters the server keeps for the lines it adds around the description.
 */
export const FEEDBACK_DESCRIPTION_MAX = 64000;

/** How much of the description the live title preview sends to be named. */
export const TITLE_SOURCE_MAX = 2000;
