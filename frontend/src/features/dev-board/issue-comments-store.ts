/**
 * `#dev-issue-comments` — the GitHub comment thread under an issue's topic
 * card — as a view model.
 *
 * ── One host, one owner ───────────────────────────────────────────────
 *
 * The host is rendered once by `AppView._renderTopicHead` (an empty
 * `<div id="dev-issue-comments">` at the end of the issue body) and filled
 * after a fetch that runs on the next paint. It is a REAL boundary, not a
 * seam inside a card: nothing else writes into it, and the card around it is
 * still a string renderer only because the card family has not converted yet.
 *
 * ── The bodies are sanitized markdown ─────────────────────────────────
 *
 * A comment's body is arbitrary GitHub markdown, rendered by
 * `DevChat.renderMarkdown` — which is the same sanitizer the dev chat and the
 * group chat's transcript run their bodies through. It arrives here already
 * rendered, as HTML, exactly as it did when this was a string; the component
 * spells that out with `dangerouslySetInnerHTML`, which is where an HTML
 * string in a React tree belongs.
 *
 * ── What stays in app-view.js ─────────────────────────────────────────
 *
 * The fetch and its per-issue cache, the staleness check that drops a result
 * for an issue the reader has navigated away from, the sanitizer choice and
 * its fallback for a page where dev-chat.js did not load, and
 * `_isBotCommentAuthor`.
 */

import { createStore } from '../../lib/plain-store.js';

export interface IssueCommentView {
  /** Stable per row — GitHub's own comment id where there is one. */
  key: string;
  author: string;
  /** GitHub's bot accounts get a quiet tag rather than a different row. */
  bot: boolean;
  /** `YYYY-MM-DD`, or '' when the row carries no timestamp. */
  date: string;
  /** Sanitized markdown, already rendered by the module. */
  bodyHtml: string;
}

export interface IssueCommentsState {
  comments: IssueCommentView[];
  /** GitHub caps what the API returns; say so, and link out. */
  truncated: boolean;
  /** The issue's page on GitHub, for that link. Null when unknown. */
  htmlUrl: string | null;
}

export const EMPTY_ISSUE_COMMENTS: IssueCommentsState = {
  comments: [],
  truncated: false,
  htmlUrl: null,
};

export const issueCommentsStore = createStore<IssueCommentsState>(EMPTY_ISSUE_COMMENTS);
