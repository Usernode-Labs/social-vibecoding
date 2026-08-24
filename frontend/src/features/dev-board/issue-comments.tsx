/**
 * `#dev-issue-comments` — the GitHub thread under an issue's topic card — as
 * the only React writer below that host. See ./issue-comments-store.ts.
 */

import { useMemo } from 'react';

import { useStoreState } from '../../lib/use-store-state';
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
    <div className="text-xs text-zinc-600 dark:text-zinc-300" dangerouslySetInnerHTML={wrapper} />
  );
}

function Comment({ comment }: { comment: IssueCommentView }) {
  return (
    <div className="dev-issue-comment border border-zinc-200 dark:border-zinc-800 rounded-xl p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
          {comment.author}
        </span>
        {comment.bot ? (
          <span className="text-[0.9375rem] text-sky-600 dark:text-sky-400">bot</span>
        ) : null}
        {comment.date ? (
          <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{comment.date}</span>
        ) : null}
      </div>
      <Body html={comment.bodyHtml} />
    </div>
  );
}

export function IssueCommentsView({ comments, truncated, htmlUrl }: IssueCommentsState) {
  // No comments is no section at all, not an empty "Discussion" heading.
  if (!comments.length) return null;
  return (
    <div className="flex flex-col gap-2 mt-2">
      <div className="text-[0.9375rem] text-zinc-400 dark:text-zinc-500 px-1">Discussion</div>
      {truncated ? (
        <div className="text-[11px] text-zinc-400 dark:text-zinc-500 px-1">
          {'Earlier comments omitted — '}
          {htmlUrl ? (
            <a
              href={htmlUrl}
              target="_blank"
              rel="noopener"
              className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              view the full thread on GitHub
            </a>
          ) : 'view the full thread on GitHub'}
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
