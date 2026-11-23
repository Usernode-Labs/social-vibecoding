/**
 * THE THREAD'S HEAD CARD, ONE FOR EVERY THREAD PAGE (20 Nov 2026).
 *
 * A request's page, a change's page and a private thread with Homeroom bot
 * all lead with the same card (app.css "THE THREAD'S HEAD IS A CARD"): a
 * tile, a small line over the title in two lines at most, then the head's
 * own buttons (⋯, the one disc) and, in a column, its ways out after a thin
 * line. Scrolled, it tightens (./thread-head-fit.ts).
 *
 * The private thread drew a copy of it from its own markup and its own rules
 * (#6863, #6877), and the copy drifted: a 446px strip, its Preview forced
 * into the round button. Now every head is this component and every page
 * the shared page around it (../../group-chat/thread-page.tsx), so the
 * stylesheet has one head to draw.
 *
 * The nodes keep the order and the classes the head card's rules and the
 * declared checks read: the tile, then `.dev-thread-bar-text` holding the
 * small line (`line`), the title (`title`) and the project and topic
 * (`sub`), then `menu` and `exits`.
 */

import { useRef, type HTMLAttributes, type ReactNode } from 'react';

import { useThreadHeadFit } from './thread-head-fit';

export function ThreadHeadCard({ lead = null, tile, line = null, title, sub = null, menu = null, exits = null, attrs }: {
  /** A button before the tile, where a phone draws its back arrow. */
  lead?: ReactNode;
  /** The project's tile, or the other member's round face. */
  tile: ReactNode;
  /** The small line over the title: what the thread is, and where it stands. */
  line?: ReactNode;
  /** The title, a `.messages-thread-name`. */
  title: ReactNode;
  /** The project and the topic, which the small line lays out (`.messages-thread-sub`). */
  sub?: ReactNode;
  /** The head's own buttons: Preview, then ⋯. */
  menu?: ReactNode;
  /** The ways out of a column, after a thin line (`.dev-thread-exits`). */
  exits?: ReactNode;
  /** The header's own attributes (a private thread's `data-reply-head`, which its checks find it by). */
  attrs?: HTMLAttributes<HTMLElement> & Record<`data-${string}`, string | undefined>;
}): ReactNode {
  // Measured, and tightened as the thread scrolls (./thread-head-fit.ts).
  const head = useRef<HTMLElement>(null);
  useThreadHeadFit(head, true);
  return (
    <header {...attrs} ref={head} className="messages-thread-header">
      {lead}
      {tile}
      <div className="min-w-0 flex-1 dev-thread-bar-text">
        {line}
        {title}
        {sub}
      </div>
      {menu}
      {exits}
    </header>
  );
}
