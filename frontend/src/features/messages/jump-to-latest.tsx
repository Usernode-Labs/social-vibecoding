import type { RefObject } from 'react';

import { JumpToLatestButton, TranscriptOverlay } from '@/components/ui/chat';
import { useMessages } from '../../lib/i18n/react';
import { jumpLabel, useUnreadAffordances, type UnreadRow } from './unread-anchor';

/*
 * Jump to latest on its own, for a transcript drawn by somebody else or with
 * no "New" line of its own: a reply thread beside a conversation, and the
 * group chat's (a project's channel, a proposal's or a request's
 * discussion), whose rows and scrolling public/js/group-chat.js owns.
 * Rendered AFTER the scroller, as its sibling; it reads where the scroller
 * is and, on a tap, glides it to the bottom, where the owner's own scroll
 * listener takes the reader as following again. It writes nothing inside the
 * scroller.
 *
 * `docked` (#4553) is for a page whose cards would sit under the disc — a
 * change's or a request's page, a project topic: there the button docks into
 * its own thin strip between the scroller and the composer instead of
 * floating over the transcript's foot, and the strip goes with it at the
 * bottom, so the page gets its full height back. Chats keep the floating
 * disc: floating over messages is the normal pattern there.
 *
 * The conversation itself (./index.tsx) draws the same button from the same
 * hook beside its banner.
 */

const NO_LINE: RefObject<HTMLElement | null> = { current: null };
const NO_ROWS: readonly UnreadRow[] = [];

export function JumpToLatest({ scroller, slack, rows = NO_ROWS, docked = false }: {
  scroller: RefObject<HTMLElement | null>;
  /** The allowance the transcript follows new messages within. */
  slack?: number;
  /** The transcript's messages, oldest first, when the caller has them: the dot counts what arrives. */
  rows?: readonly UnreadRow[];
  /** Dock into a shrink-0 strip below the scroller instead of floating over its foot. */
  docked?: boolean;
}) {
  const t = useMessages('messages');
  const { view, toLatest } = useUnreadAffordances(scroller, NO_LINE, {
    conversation: null, markKey: '', lineAt: null, rows, slack, watchContent: true,
  });
  const button = (
    <JumpToLatestButton shown={view.jump} dot={view.arrived > 0} aria-label={jumpLabel(view.arrived)} title={t('messages:thread.jumpToLatest')} onClick={toLatest} />
  );
  if (docked) {
    // One class string or the other, never both on the node: `hidden` beside
    // a display utility is the clap-chip bug again — the utility wins.
    return (
      <div data-transcript-strip="foot" className={view.jump ? 'flex shrink-0 justify-center px-4 py-1' : 'hidden'}>
        {button}
      </div>
    );
  }
  return (
    <TranscriptOverlay edge="foot">
      {button}
    </TranscriptOverlay>
  );
}
