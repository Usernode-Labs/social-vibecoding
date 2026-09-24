import type { ReactNode } from 'react';

import { ChevronRightIcon } from '@/components/ui/icons';

import { agoStamp } from '../../lib/timestamp';

/**
 * "3 replies · Last reply 12m ago ›" under a message a thread hangs off
 * (#2387). The faces of the last few repliers lead it, the way Slack draws
 * it, so a glance says who is talking in there. It is the door to the thread:
 * the whole chip opens it.
 *
 * The faces are the caller's (`avatars`): the Messages screen draws its
 * people with their avatar images, the app chat with its letter swatches.
 */
export function ThreadSummaryChip({ replyCount, lastReplyAt, avatars, active = false, onOpen }: {
  replyCount: number;
  lastReplyAt: string | null;
  avatars?: ReactNode;
  /** This thread is the one open beside the transcript. */
  active?: boolean;
  onOpen: () => void;
}) {
  const last = lastReplyAt ? agoStamp(lastReplyAt) : null;
  const count = `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;
  return (
    <button
      type="button"
      className={`msgx-thread-chip ${active ? 'msgx-thread-chip-active' : ''}`}
      aria-label={`${count}${last?.text ? `, last reply ${last.text}` : ''}. Open thread`}
      aria-pressed={active}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
    >
      {avatars ? <span className="msgx-thread-faces" aria-hidden="true">{avatars}</span> : null}
      <span className="msgx-thread-count">{count}</span>
      {last?.text ? <span className="msgx-thread-last" title={last.title}>Last reply {last.text}</span> : null}
      <ChevronRightIcon className="msgx-thread-chevron" aria-hidden="true" />
    </button>
  );
}
