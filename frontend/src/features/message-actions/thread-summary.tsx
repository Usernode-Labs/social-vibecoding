import type { ReactNode } from 'react';

import { ChevronRightIcon, ThreadIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { agoStamp } from '../../lib/timestamp';

/**
 * The card under a message a thread hangs off (#2387, Discord's layout since
 * the follow-up): "3 replies ›" on top, then the newest reply — its author's
 * face and name, a line of what they said, and when. It is the door to the
 * thread: the whole card opens it.
 *
 * The faces are the caller's: the Messages screen draws its people with their
 * avatar images, the app chat with its letter swatches. A summary from a
 * server that does not name the newest reply draws the older chip instead —
 * the recent repliers' faces and "Last reply 12m ago".
 */
export function ThreadSummaryChip({ replyCount, lastReplyAt, avatars, lastReply = null, active = false, onOpen }: {
  replyCount: number;
  lastReplyAt: string | null;
  avatars?: ReactNode;
  /** The newest reply: its author's face, name and a line of what they said. */
  lastReply?: { face: ReactNode; name: string; text: string } | null;
  /** This thread is the one open beside the transcript. */
  active?: boolean;
  onOpen: () => void;
}) {
  const last = lastReplyAt ? agoStamp(lastReplyAt) : null;
  const t = useMessages('messages');
  const count = t('messages:thread.summary.count', { count: replyCount });
  if (lastReply) {
    return (
      <button
        type="button"
        className={`msgx-thread-chip msgx-thread-card ${active ? 'msgx-thread-chip-active' : ''}`}
        aria-label={last?.text
          ? t('messages:thread.summary.openLastFromAt', { count: replyCount, username: lastReply.name, when: last.text })
          : t('messages:thread.summary.openLastFrom', { count: replyCount, username: lastReply.name })}
        aria-pressed={active}
        onClick={(event) => { event.stopPropagation(); onOpen(); }}
      >
        <span className="msgx-thread-card-head">
          <ThreadIcon className="msgx-thread-card-glyph" aria-hidden="true" />
          <span className="msgx-thread-count">{count}</span>
          <ChevronRightIcon className="msgx-thread-card-chevron" aria-hidden="true" />
        </span>
        <span className="msgx-thread-line">
          {lastReply.face}
          <strong className="msgx-thread-line-name">@{lastReply.name}</strong>
          <span className="msgx-thread-line-text">{lastReply.text || t('messages:thread.summary.attachment')}</span>
          {last?.text ? <time className="msgx-thread-line-time" dateTime={lastReplyAt || undefined} title={last.title}>{last.text}</time> : null}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      className={`msgx-thread-chip ${active ? 'msgx-thread-chip-active' : ''}`}
      aria-label={last?.text
        ? t('messages:thread.summary.openLastAt', { count: replyCount, when: last.text })
        : t('messages:thread.summary.open', { count: replyCount })}
      aria-pressed={active}
      onClick={(event) => { event.stopPropagation(); onOpen(); }}
    >
      {avatars ? <span className="msgx-thread-faces" aria-hidden="true">{avatars}</span> : null}
      <span className="msgx-thread-count">{count}</span>
      {last?.text ? <span className="msgx-thread-last" title={last.title}>{t('messages:thread.summary.lastReply', { when: last.text })}</span> : null}
      <ChevronRightIcon className="msgx-thread-chevron" aria-hidden="true" />
    </button>
  );
}
