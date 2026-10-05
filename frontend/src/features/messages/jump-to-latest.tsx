import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import type { RefObject } from 'react';

import { JumpToLatestButton, TranscriptOverlay } from '@/components/ui/chat';
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
 * The conversation itself (./index.tsx) draws the same button from the same
 * hook beside its banner.
 */

const NO_LINE: RefObject<HTMLElement | null> = { current: null };
const NO_ROWS: readonly UnreadRow[] = [];

export function JumpToLatest({ scroller, slack, rows = NO_ROWS }: {
  scroller: RefObject<HTMLElement | null>;
  /** The allowance the transcript follows new messages within. */
  slack?: number;
  /** The transcript's messages, oldest first, when the caller has them: the dot counts what arrives. */
  rows?: readonly UnreadRow[];
}) {
  useUiLanguage("community");
  const { view, toLatest } = useUnreadAffordances(scroller, NO_LINE, {
    conversation: null, markKey: '', lineAt: null, rows, slack, watchContent: true,
  });
  return (
    <TranscriptOverlay edge="foot">
      <JumpToLatestButton shown={view.jump} dot={view.arrived > 0} aria-label={jumpLabel(view.arrived)} title={tr("community:sync_jump_to_latest_86752458")} onClick={toLatest} />
    </TranscriptOverlay>
  );
}
