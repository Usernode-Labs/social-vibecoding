/**
 * The Messages list's loading placeholders (#2718).
 *
 * They were a spinner beside the words "Loading conversations…" — a fixed
 * mark that says "busy, somewhere" over an empty pane. These say where the
 * rows are going and roughly how many, so the arriving rows land on their own
 * outlines instead of replacing a centred line of grey text.
 *
 * The wrapper IS `.messages-conversation-row`, not an imitation of it: that
 * class owns the 66px minimum height, the padding, the gap and the inset
 * separator, all in app.css. Borrowing it means the placeholder cannot drift
 * from the row the first time any of those move — and the separator between
 * placeholders is drawn for free, which is most of what makes a list read as
 * a list.
 *
 * Six, because the pane is taller than that on every phone and a list that
 * stops halfway reads as a short list rather than a loading one.
 *
 * Its own module since #6992: the community rail's channel drawer draws the
 * same placeholder while a community's record loads, and a second copy would
 * be the one that drifts.
 */

import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { useMessages } from '../../lib/i18n/react';

export function ConversationRowSkeleton() {
  const t = useMessages('messages');
  return (
    <SkeletonGroup label={t('messages:inbox.loading')}>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="messages-conversation-row">
          {/* The `lg` square UserAvatar's 44px box. */}
          <Skeleton shape="block" className="w-11 h-11 rounded-xl" />
          <div className="min-w-0 flex-1">
            {/* The name line, with the timestamp's short bar pushed right —
                the real row's trailing <time>. */}
            <div className="flex items-center gap-2">
              <Skeleton className={i % 2 ? 'w-28' : 'w-36'} />
              <Skeleton shape="muted" className="ms-auto w-8" />
            </div>
            {/* The preview line under it. */}
            <Skeleton shape="muted" className={`mt-1.5 ${i % 3 ? 'w-3/5' : 'w-2/5'}`} />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}
