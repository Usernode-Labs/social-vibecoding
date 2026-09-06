/**
 * `#dev-issue-comments` — the GitHub thread under an issue's topic card — as
 * the only React writer below that host. See ./issue-comments-store.ts.
 */

import { useMemo } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { swatchFor } from '../messages/format';
import {
  issueCommentsStore,
  type IssueCommentsState,
  type IssueCommentView,
} from './issue-comments-store';

/**
 * The sanitized markdown the module produced.
 *
 * Memoised on the STRING so the `{__html}` wrapper keeps its identity across
 * re-renders: React diffs host props by reference and re-assigns `innerHTML`
 * whenever that object is new, even for an identical string. The group chat's
 * transcript hit exactly this — see the note in
 * features/group-chat/transcript.tsx.
 */
function Body({ html }: { html: string }) {
  const wrapper = useMemo(() => ({ __html: html }), [html]);
  return (
    <div className="dev-feed-msg-text dev-issue-body" dangerouslySetInnerHTML={wrapper} />
  );
}

/**
 * One GitHub comment, as a BUBBLE — the Activity feed's reply row, with a
 * small "GitHub" tag after the author so it reads as the repository's
 * conversation inside the topic's one Discussion sheet, and not as a reply
 * the box below would post next to (that box posts to the app's thread).
 */
function Comment({ comment }: { comment: IssueCommentView }) {
  return (
    <div className="dev-issue-comment dev-feed-msg">
      <span className="dev-feed-msg-avatar" aria-hidden="true" style={{ backgroundColor: swatchFor(comment.author) }}>
        {(comment.author || '?').slice(0, 1).toUpperCase()}
      </span>
      <div className="dev-feed-msg-bubble">
        <div className="dev-feed-msg-head">
          <span className="dev-feed-msg-author">{comment.author}</span>
          {comment.bot ? (
            <span className="text-[0.9375rem] text-sky-700 dark:text-sky-400">bot</span>
          ) : null}
          <span className="dev-topic-gh-tag">GitHub</span>
          {comment.date ? (
            <span className="dev-feed-msg-time">{comment.date}</span>
          ) : null}
        </div>
        <Body html={comment.bodyHtml} />
      </div>
    </div>
  );
}

export function IssueCommentsView({ comments, truncated, htmlUrl }: IssueCommentsState) {
  // No comments is no section at all, not an empty "Discussion" heading.
  if (!comments.length) return null;
  return (
    <div className="dev-topic-gh-thread">
      <div className="dev-topic-h">Discussion</div>
      {truncated ? (
        <div className="dev-topic-gh-more">
          {'Earlier comments omitted. '}
          {htmlUrl ? (
            <a
              href={htmlUrl}
              target="_blank"
              rel="noopener"
              className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              View the full thread on GitHub
            </a>
          ) : 'View the full thread on GitHub'}
          .
        </div>
      ) : null}
      {comments.map((comment) => <Comment key={comment.key} comment={comment} />)}
    </div>
  );
}

export function IssueComments() {
  return <IssueCommentsView {...useStoreState<IssueCommentsState>(issueCommentsStore)} />;
}
