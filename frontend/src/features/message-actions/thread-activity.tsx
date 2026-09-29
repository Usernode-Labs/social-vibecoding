import type { ReactNode } from 'react';

import { ChevronRightIcon, ThreadIcon } from '@/components/ui/icons';

/** One reply as a thread-activity card lists it. */
export interface ThreadActivityReply {
  key: string | number;
  /** The author's face, drawn by the caller in its own style. */
  face: ReactNode;
  name: string;
  text: string;
}

/** The most reply lines one card draws; its head still counts them all. */
export const THREAD_ACTIVITY_LINES = 3;

/**
 * A thread's replies, drawn in the MAIN transcript where they landed (#2387
 * follow-up). The thread keeps the conversation readable; this keeps its
 * chronology: the transcript says, at the time it happened, that somebody
 * answered in a thread, instead of only a count changing on a message
 * scrolled far above.
 *
 * Replies to one thread with nothing else said between them share ONE card
 * ("2 replies in thread"), so a busy thread adds one entry, not one per line.
 * The card is the thread card's white box; the thread glyph sits in the
 * column the transcript's faces use, which marks it as activity rather than
 * somebody's message. A tap opens the thread.
 */
export function ThreadActivityCard({ rootText, rootDeleted = false, time, timeTitle, replies, onOpen }: {
  /** The start of the message the thread hangs off. */
  rootText: string;
  rootDeleted?: boolean;
  /** When: one reply's time, or the first and last of a merged run. */
  time: string;
  timeTitle?: string;
  replies: ThreadActivityReply[];
  onOpen: () => void;
}) {
  const count = replies.length;
  const what = count === 1 ? 'Replied in thread' : `${count} replies in thread`;
  const root = rootDeleted ? 'Message deleted' : (rootText || 'a message');
  return (
    <div className="msgx-thread-activity">
      <span className="msgx-thread-activity-glyph" aria-hidden="true"><ThreadIcon /></span>
      <button
        type="button"
        className="msgx-thread-activity-card"
        aria-label={`${what}: ${root}, ${time}. Open thread`}
        onClick={(event) => { event.stopPropagation(); onOpen(); }}
      >
        <span className="msgx-thread-activity-head">
          <span className="msgx-thread-activity-what">{what}</span>
          <span className={`msgx-thread-activity-root ${rootDeleted ? 'msgx-thread-activity-root-deleted' : ''}`}>{root}</span>
          <time className="msgx-thread-activity-time" title={timeTitle}>· {time}</time>
          <ChevronRightIcon className="msgx-thread-card-chevron" aria-hidden="true" />
        </span>
        {replies.slice(-THREAD_ACTIVITY_LINES).map((reply) => (
          <span key={reply.key} className="msgx-thread-line">
            {reply.face}
            <strong className="msgx-thread-line-name">@{reply.name}</strong>
            <span className="msgx-thread-line-text">{reply.text || 'Attachment'}</span>
          </span>
        ))}
      </button>
    </div>
  );
}
