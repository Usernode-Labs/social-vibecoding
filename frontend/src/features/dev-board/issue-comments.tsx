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
        {/* `azure`, not `sky`: sky-* is not an overridden ramp, so it rendered
            stock Tailwind next to the platform's tuned hues. Light stays at
            the 700 tier (this is an identity mark, not a link) and dark pairs
            at 300 — the azure step the merges and status tables settled on. */}
        {comment.bot ? (
          <span className="text-[0.9375rem] text-azure-700 dark:text-azure-300">bot</span>
        ) : null}
        {comment.date ? (
          <span className="text-[10px] text-zinc-500 dark:text-zinc-300">{comment.date}</span>
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
      <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-300 px-1">Discussion</div>
      {truncated ? (
        <div className="text-[11px] text-zinc-500 dark:text-zinc-300 px-1">
          {'Earlier comments omitted. '}
          {htmlUrl ? (
            <a
              href={htmlUrl}
              target="_blank"
              rel="noopener"
              // The dark hover was byte-identical to the base this anchor
              // inherits (`dark:text-zinc-300` on the paragraph), so it
              // rendered nothing — the defect AdminUI.btn.link documents. 200
              // brightens, the direction dev-card.tsx's edit pencil already
              // spells for this exact pattern.
              className="underline hover:text-zinc-600 dark:hover:text-zinc-200"
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
