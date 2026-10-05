import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
/**
 * `#dev-issue-comments` — the GitHub thread under an issue's topic card — as
 * the only React writer below that host. See ./issue-comments-store.ts.
 */

import { useMemo, useState } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';
import { messageStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { swatchFor } from '../messages/format';
import { useInlineImageViewer } from '../image-viewer/image-viewer';
import { ClampedComment } from './comment-clamp';
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
  // #2556: four lines, then a "Show more". The clamp sits on this same node
  // rather than a wrapper around it, so the sanitized markup keeps the box
  // its CSS is written against — `#dev-issue-comments .dev-feed-msg-text`
  // sets the font size, and `.dev-issue-body` the markdown treatment.
  return (
    <ClampedComment className="dev-feed-msg-text dev-issue-body" contentKey={html} html={wrapper} />
  );
}

/**
 * Which specs the reader has opened, by comment. The host is mounted again on
 * every WS-driven repaint of the topic head (app-view.js `_loadIssueComments`),
 * so a spec open in component state alone would fold itself shut under the
 * reader at the next vote or message.
 */
const openSpecs = new Set<string>();

/**
 * #3490: Homeroom bot's spec, drawn as a spec rather than as the lines of a
 * comment. On GitHub the bot folds it away under "The spec"; here it is a
 * card with the spec's title on it, folded the same way, and opening it
 * shows the spec in the spec viewer's own typography (`.dc-spec-viewer-body`,
 * headings as headings, paragraphs as paragraphs) at its full length, outside
 * the comment's four-line clamp.
 */
function BotSpec({ id, spec }: { id: string; spec: NonNullable<IssueCommentView['spec']> }) {
  useUiLanguage();
  const wrapper = useMemo(() => ({ __html: spec.html }), [spec.html]);
  const [open, setOpen] = useState(() => openSpecs.has(id));
  return (
    <details
      className="dev-issue-spec"
      data-issue-spec=""
      open={open}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now) openSpecs.add(id); else openSpecs.delete(id);
        if (now !== open) setOpen(now);
      }}
    >
      <summary className="dev-issue-spec-head">
        <span className="dev-issue-spec-text">
          <span className="dev-issue-spec-kicker"><Message id="workshop:the_spec_a1344a81" /></span>
          {spec.title ? <span className="dev-issue-spec-title">{spec.title}</span> : null}
        </span>
        <ChevronDownIcon className="dev-issue-spec-chev" aria-hidden="true" />
      </summary>
      <div className="dc-spec-viewer-body dev-issue-spec-body" dangerouslySetInnerHTML={wrapper} />
    </details>
  );
}

/**
 * One GitHub comment, as a BUBBLE — the Activity feed's reply row, with a
 * small "GitHub" tag after the author so it reads as the repository's
 * conversation inside the topic's one Discussion sheet, and not as a reply
 * the box below would post next to (that box posts to the app's thread).
 */
function Comment({ comment }: { comment: IssueCommentView }) {
  // #1808: the same stamp the Discussion thread directly below this one
  // shows, from the same helper — a date once it is not today's, a year once
  // it is not this one, and the unelided form in `title`. This row used to
  // print a bare UTC `YYYY-MM-DD` with no time.
  const stamp = messageStamp(comment.createdAt);
  return (
    <div className="dev-issue-comment dev-feed-msg">
      <span className="dev-feed-msg-avatar" aria-hidden="true" style={{ backgroundColor: swatchFor(comment.author) }}>
        {(comment.author || '?').slice(0, 1).toUpperCase()}
      </span>
      <div className="dev-feed-msg-bubble">
        <div className="dev-feed-msg-head">
          <span className="dev-feed-msg-author">{comment.author}</span>
          {comment.bot ? (
            <span className="text-[0.9375rem] text-sky-700 dark:text-sky-400"><Message id="workshop:bot_9d74932b" /></span>
          ) : null}
          <span className="dev-topic-gh-tag"><Message id="workshop:github_f911e414" /></span>
          {stamp.text ? (
            <time className="dev-feed-msg-time" dateTime={comment.createdAt} title={stamp.title}>
              {stamp.text}
            </time>
          ) : null}
        </div>
        {comment.spec && !comment.bodyHtml ? null : <Body html={comment.bodyHtml} />}
        {comment.spec ? <BotSpec id={comment.key} spec={comment.spec} /> : null}
      </div>
    </div>
  );
}

export function IssueCommentsView({ comments, truncated, htmlUrl }: IssueCommentsState) {
  // #3908: a screenshot in a comment (GitHub's upload, or one pasted as
  // markdown) opens in the app's viewer over the page, as one in the
  // request's own body does (topic/topic-head.tsx TopicBodySections).
  const images = useInlineImageViewer();
  // No comments is no section at all, not an empty "Discussion" heading.
  if (!comments.length) return null;
  return (
    <div className="dev-topic-gh-thread" {...images.scope}>
      {images.viewer}
      <div className="dev-topic-h"><Message id="workshop:discussion_5eb6cf64" /></div>
      {truncated ? (
        <div className="dev-topic-gh-more">
          <Message id="workshop:earlier_comments_omitted_5c0d8232" />
          <LocalizedValue render={() => (htmlUrl ? (
            <a
              href={htmlUrl}
              target="_blank"
              rel="noopener"
              className="underline hover:text-zinc-600 dark:hover:text-zinc-300"
            ><Message id="workshop:view_the_full_thread_on_github_055c3a2a" /></a>
          ) : tr("workshop:view_the_full_thread_on_github_055c3a2a"))} />
          .
        </div>
      ) : null}
      {comments.map((comment) => <Comment key={comment.key} comment={comment} />)}
    </div>
  );
}

export function IssueComments() {
  useUiLanguage();
  return <IssueCommentsView {...useStoreState<IssueCommentsState>(issueCommentsStore)} />;
}
